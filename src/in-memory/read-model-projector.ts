import { IEvent, IMetadataMatcher, IReadModelConstructor } from '../';
import { ProjectionStatus, IProjectionManager, IReadModel, IReadModelProjector, IState, IStream } from '../projection';

import { InMemoryEventStore } from './event-store';
import { ProjectorException, ProjectionNotFound } from '../exception';

const cloneDeep = require('lodash.clonedeep');

export class InMemoryReadModelProjector<R extends IReadModel, T extends IState = IState> implements IReadModelProjector<R, T> {
  private state?: T;
  private initHandler?: () => T;
  private handlers?: {
    [event: string]: <R extends IEvent>(state: T, event: R) => T | Promise<T>;
  };
  private handler?: <R extends IEvent>(state: T, event: R) => T | Promise<T>;
  private metadataMatchers: { [streamName: string]: IMetadataMatcher } = {};
  private streamPositions: { [stream: string]: number } = {};

  private streamCreated: boolean = false;
  private isStopped: boolean = false;
  public readonly readModel: R;

  private query: { all: boolean; streams: Array<string> } = {
    all: false,
    streams: [],
  };

  constructor(
    private readonly name: string,
    private readonly manager: IProjectionManager,
    private readonly eventStore: InMemoryEventStore,
    private readonly projections: {
      [projection: string]: {
        state: IState;
        positions: object;
        status: ProjectionStatus;
      };
    },
    ReadModelConstructor: IReadModelConstructor<R>,
    private status: ProjectionStatus = ProjectionStatus.IDLE
  ) {
    this.readModel = new ReadModelConstructor(null);
  }

  init(callback: () => T): IReadModelProjector<R, T> {
    if (this.initHandler !== undefined) {
      throw ProjectorException.alreadyInitialized();
    }

    this.initHandler = callback;
    this.initHandler.bind(this);

    this.state = this.initHandler();

    return this;
  }

  fromAll(): IReadModelProjector<R, T> {
    if (this.query.all || this.query.streams.length > 0) {
      throw ProjectorException.fromWasAlreadyCalled();
    }

    this.query.all = true;

    return this;
  }

  fromStream(stream: IStream): IReadModelProjector<R, T> {
    if (this.query.all || this.query.streams.length > 0) {
      throw ProjectorException.fromWasAlreadyCalled();
    }

    this.query.streams.push(stream.streamName);
    this.metadataMatchers[stream.streamName] = stream.matcher;

    return this;
  }

  fromStreams(...streams: IStream[]): IReadModelProjector<R, T> {
    if (this.query.all || this.query.streams.length > 0) {
      throw ProjectorException.fromWasAlreadyCalled();
    }

    this.query.streams = streams.map(stream => stream.streamName);
    this.metadataMatchers = streams.reduce((matchers, stream) => {
      matchers[stream.streamName] = stream.matcher;

      return matchers;
    }, {});

    return this;
  }

  when(handlers: { [p: string]: (state: T, event: IEvent) => T }): IReadModelProjector<R, T> {
    if (this.handler || this.handlers) {
      throw ProjectorException.whenWasAlreadyCalled();
    }

    Object.values(handlers).forEach(handler => handler.bind(this));

    this.handlers = { ...handlers };

    return this;
  }

  whenAny(handler: (state: T, event: IEvent) => T): IReadModelProjector<R, T> {
    if (this.handler || this.handlers) {
      throw ProjectorException.whenWasAlreadyCalled();
    }

    handler.bind(this);

    this.handler = handler;

    return this;
  }

  async emit(event: IEvent<object>): Promise<void> {
    if (this.streamCreated === false && (await this.eventStore.hasStream(this.name)) === false) {
      await this.eventStore.createStream(this.name);
      this.streamCreated = true;
    }

    this.eventStore.appendTo(this.name, [event]);
  }

  async linkTo(streamName: string, event: IEvent<object>): Promise<void> {
    if ((await this.eventStore.hasStream(streamName)) === false) {
      await this.eventStore.createStream(streamName);
    }

    await this.eventStore.appendTo(streamName, [event]);
  }

  async delete(deleteProjection: boolean = true): Promise<void> {
    delete this.projections[this.name];

    this.isStopped = true;
    this.state = undefined;

    if (this.initHandler !== undefined) {
      this.state = this.initHandler();
    }

    if (deleteProjection) {
      await this.readModel.delete();
    }

    this.streamPositions = {};
  }

  async reset(): Promise<void> {
    this.streamPositions = {};
    await this.readModel.reset();
    this.state = undefined;

    if (this.initHandler !== undefined) {
      this.state = this.initHandler();
    }

    this.projections[this.name] = {
      state: {},
      positions: this.streamPositions,
      status: ProjectionStatus.IDLE,
    };

    await this.eventStore.deleteStream(this.name);
  }

  async stop(): Promise<void> {
    await this.persist();

    this.isStopped = true;

    await this.manager.idleProjection(this.name);

    this.status = ProjectionStatus.IDLE;
  }

  getName(): string {
    return this.name;
  }

  getState(): T {
    return this.state;
  }

  async run(keepRunning: boolean = false): Promise<void> {
    if (!this.handler && !this.handlers) {
      throw ProjectorException.noHandler();
    }

    if (this.state === undefined) {
      throw ProjectorException.stateWasNotInitialised();
    }

    switch (await this.fetchRemoteStatus()) {
      case ProjectionStatus.STOPPING:
        await this.load();
        await this.stop();
        break;
      case ProjectionStatus.DELETING:
        await this.delete();
        break;
      case ProjectionStatus.DELETING_INCL_EMITTED_EVENTS:
        await this.delete(true);
        break;
      case ProjectionStatus.RESETTING:
        await this.reset();

        if (keepRunning) {
          await this.startAgain();
        }
        break;
    }

    if ((await this.projectionExists()) === false) {
      await this.createProjection();
    }

    if ((await this.readModel.isInitialized()) === false) {
      await this.readModel.init();
    }

    await this.prepareStreamPosition();
    await this.load();

    this.isStopped = false;

    do {
      const evenStream = await this.eventStore.mergeAndLoad(
        ...Object.entries(this.streamPositions).map(([streamName, position]) => ({
          streamName,
          fromNumber: position + 1,
          matcher: this.metadataMatchers[streamName],
        }))
      );

      if (this.handler) {
        await this.handleStreamWithSingleHandler(evenStream);
      } else {
        await this.handleStreamWithHandlers(evenStream);
      }

      switch (await this.fetchRemoteStatus()) {
        case ProjectionStatus.STOPPING:
          await this.stop();
          break;
        case ProjectionStatus.DELETING:
          await this.delete();
          break;
        case ProjectionStatus.DELETING_INCL_EMITTED_EVENTS:
          await this.delete(true);
          break;
        case ProjectionStatus.RESETTING:
          await this.reset();

          if (keepRunning) {
            await this.startAgain();
          }
          break;
      }

      await this.prepareStreamPosition();
    } while (keepRunning && !this.isStopped);
  }

  public progressEvent(event: string): boolean {
    if (this.handler) {
      return true;
    }

    return Object.keys(this.handlers).includes(event);
  }

  private async handleStreamWithSingleHandler(eventStreams: AsyncIterable<IEvent>) {
    for await (const event of eventStreams) {
      this.streamPositions[event.metadata.stream]++;

      this.state = cloneDeep(await this.handler(this.state, event));

      if (this.isStopped) {
        break;
      }
    }
  }

  private async handleStreamWithHandlers(eventStreams: AsyncIterable<IEvent>) {
    for await (const event of eventStreams) {
      this.streamPositions[event.metadata.stream]++;

      if (this.handlers[event.name] === undefined) {
        if (this.isStopped) {
          break;
        }

        continue;
      }

      this.state = cloneDeep(await this.handlers[event.name](this.state, event));

      if (this.isStopped) {
        break;
      }
    }
  }

  private async persist(): Promise<void> {
    await this.readModel.persist();

    this.projections[this.name] = {
      ...this.projections[this.name],
      state: this.state || {},
      positions: this.streamPositions,
    };
  }

  private async load(): Promise<void> {
    const result = this.projections[this.name];

    if (!result) {
      throw ProjectionNotFound.withName(this.name);
    }

    this.streamPositions = { ...this.streamPositions, ...result.positions };
    this.state = { ...(result.state as any) };
  }

  private async prepareStreamPosition(): Promise<void> {
    let streamPositions = {};

    if (this.query.all) {
      const result = Object.keys(this.eventStore.eventStreams);

      streamPositions = result.reduce((acc, stream) => {
        acc[stream] = 0;

        return acc;
      }, {});
    }

    if (this.query.streams.length > 0) {
      streamPositions = this.query.streams.reduce((acc, streamName) => {
        acc[streamName] = 0;

        return acc;
      }, {});
    }

    this.streamPositions = { ...streamPositions, ...this.streamPositions };
  }

  private async fetchRemoteStatus(): Promise<ProjectionStatus> {
    try {
      return await this.manager.fetchProjectionStatus(this.name);
    } catch (e) {
      return ProjectionStatus.RUNNING;
    }
  }

  private async startAgain() {
    this.isStopped = false;

    if (!this.projections[this.name]) {
      throw ProjectionNotFound.withName(this.name);
    }

    this.projections[this.name] = {
      ...this.projections[this.name],
      status: ProjectionStatus.RUNNING,
    };

    this.status = ProjectionStatus.RUNNING;
  }

  private async projectionExists(): Promise<boolean> {
    return !!this.projections[this.name];
  }

  private async createProjection(): Promise<void> {
    this.projections[this.name] = {
      state: {},
      positions: {},
      status: ProjectionStatus.IDLE,
    };
  }
}
