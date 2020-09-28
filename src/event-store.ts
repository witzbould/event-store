import { AggregateEventMap, Options, EventAction, EventCallback, IEventStore, IEvent, LoadStreamParameter, IMetadataMatcher } from './types';

import {
  IProjectionManager,
  IState,
  IReadModelProjector,
  IProjector,
  IProjectionConstructor,
  IReadModel,
  IReadModelProjectionConstructor
} from './projection';

import { IAggregate, IAggregateConstructor, AggregateRepository, IAggregateRepository } from './aggregate';
import { ProjectionNotFound } from './exception';
import { MiddlewareIterator } from './middleware/iterator';

interface MiddlewareCollection {
  [EventAction.APPEND_ERRORED]: EventCallback[];
  [EventAction.PRE_APPEND]: EventCallback[];
  [EventAction.APPENDED]: EventCallback[];
  [EventAction.LOADED]: EventCallback[];
}

export interface PersistenceStrategy {
  createEventStreamsTable(): Promise<void>;
  createProjectionsTable(): Promise<void>;
  addStreamToStreamsTable(streamName: string): Promise<void>;
  removeStreamFromStreamsTable(streamName: string): Promise<void>;
  deleteStream(streamName: string): Promise<void>;
  createSchema(streamName: string): Promise<void>;
  dropSchema(streamName: string): Promise<void>;
  appendTo<T extends object = object>(streamName: string, events: IEvent<T>[]): Promise<void>;
  load(streamName: string, fromNumber: number, count?: number, matcher?: IMetadataMatcher):Promise<AsyncIterable<IEvent>>;
  mergeAndLoad(streams: Array<LoadStreamParameter>): Promise<AsyncIterable<IEvent>>;
  hasStream(streamName: string): Promise<boolean>;
  deleteStream(streamName: string): Promise<void>;
}

export abstract class EventStore implements IEventStore {
  protected readonly _eventMap: AggregateEventMap;
  protected abstract readonly _persistenceStrategy: PersistenceStrategy;
  protected readonly repositories = new Map<IAggregateConstructor, IAggregateRepository<any>>();

  protected _projections: { [name: string]: IProjector<any> };
  protected _readModelProjections: {
    [name: string]: IReadModelProjector<any, any>;
  };

  protected readonly middleware: MiddlewareCollection = {
    [EventAction.APPEND_ERRORED]: [],
    [EventAction.PRE_APPEND]: [],
    [EventAction.APPENDED]: [],
    [EventAction.LOADED]: [],
  };

  protected constructor(protected readonly options: Options) {
    this.middleware = (this.options.middleware || []).reduce<MiddlewareCollection>((carry, middleware) => {
      carry[middleware.action].push(middleware.handler);

      return carry;
    }, this.middleware);

    this._eventMap = options.registry.aggregates.reduce((map, aggregate) => {
      map[aggregate.name] = aggregate;

      return map;
    }, {});

    this._projections = options.registry.projections.reduce((acc, projection) => {
      acc[projection.projectionName] = new (projection as IProjectionConstructor)(this.getProjectionManager()).project();

      return acc;
    }, {});

    this._readModelProjections = options.registry.readModelProjections.reduce((acc, { projection, readModel }) => {
      acc[projection.projectionName] = new (projection as IReadModelProjectionConstructor<any, any>)(
        this.getProjectionManager(),
        readModel
      ).project();

      return acc;
    }, {});

    options.registry.repositories.forEach(repository => {
      repository.prototype.eventStore = this;
    });
  }

  get eventMap() {
    return this._eventMap;
  }

  get registeredProjections(): string[] {
    return [...Object.keys(this._projections), ...Object.keys(this._readModelProjections)];
  }

  public async install() {
    await this._persistenceStrategy.createEventStreamsTable();
    await this._persistenceStrategy.createProjectionsTable();

    return this;
  }

  public async createStream(streamName: string) {
    try {
      await this._persistenceStrategy.addStreamToStreamsTable(streamName);
    } catch(error) {
      console.warn(error)

      return;
    }

    try {
      await this._persistenceStrategy.createSchema(streamName);
    } catch (error) {
      await this._persistenceStrategy.removeStreamFromStreamsTable(streamName);
      await this._persistenceStrategy.dropSchema(streamName);

      throw error;
    }
  }

  public async appendTo(streamName: string, events: IEvent[]): Promise<void> {
    if (events.length === 0) return;

    events = await Promise.all(
      events.map(event => {
        return this.middleware[EventAction.PRE_APPEND].reduce<Promise<IEvent>>(async (event, handler) => {
          return handler(await event, EventAction.PRE_APPEND, this);
        }, Promise.resolve(event));
      })
    );

    try {
      await this._persistenceStrategy.appendTo(streamName, events);

      events.forEach(event => {
        return this.middleware[EventAction.APPENDED].reduce<Promise<IEvent>>(async (event, handler) => {
          return handler(await event, EventAction.APPENDED, this);
        }, Promise.resolve(event));
      });
    } catch (e) {
      events.forEach(event => {
        return this.middleware[EventAction.APPEND_ERRORED].reduce<Promise<IEvent>>(async (event, handler) => {
          return handler(await event, EventAction.APPEND_ERRORED, this);
        }, Promise.resolve(event));
      });

      throw e;
    }
  }

  public async load(streamName: string, fromNumber: number = 1, metadataMatcher?: IMetadataMatcher): Promise<AsyncIterable<IEvent>> {
    const middlewareWrapper = (handler: EventCallback, action: EventAction) => (event: IEvent) => handler(event, action, this);
    const middleware = this.middleware[EventAction.LOADED].map((handler) => middlewareWrapper(handler, EventAction.LOADED));

    return new MiddlewareIterator(await this._persistenceStrategy.load(streamName, fromNumber, undefined, metadataMatcher), middleware);
  }

  public async mergeAndLoad(...streams: LoadStreamParameter[]): Promise<AsyncIterable<IEvent>> {
    const middlewareWrapper = (handler: EventCallback, action: EventAction) => (event: IEvent) => handler(event, action, this);
    const middleware = this.middleware[EventAction.LOADED].map((handler) => middlewareWrapper(handler, EventAction.LOADED));

    return new MiddlewareIterator(await this._persistenceStrategy.mergeAndLoad(streams), middleware);
  }

  public hasStream(streamName: string): Promise<boolean> {
    return this._persistenceStrategy.hasStream(streamName);
  }

  public deleteStream(streamName: string): Promise<void> {
    return this._persistenceStrategy.deleteStream(streamName);
  }

  public createRepository<T extends IAggregate>(streamName: string, aggregate: IAggregateConstructor<T>): IAggregateRepository<T> {
    const repository = new AggregateRepository<T>({
      eventStore: this,
      streamName,
      aggregate,
    });

    this.repositories.set(aggregate, repository);

    return repository;
  }

  public getRepository<T extends IAggregate>(aggregate: IAggregateConstructor<T>): IAggregateRepository<T> {
    const repository = this.repositories.get(aggregate);

    if (!repository) {
      throw Error('No Repository for this Aggregate was created');
    }

    return repository;
  }

  public abstract getProjectionManager(): IProjectionManager;

  public getProjector<T extends IState = any>(name: string): IProjector<T> {
    const projection = this._projections[name];

    if (!projection) {
      throw ProjectionNotFound.withName(name);
    }

    return projection;
  }

  public getReadModelProjector<R extends IReadModel, T extends IState>(name: string): IReadModelProjector<R, T> {
    const projection = this._readModelProjections[name];

    if (!projection) {
      throw ProjectionNotFound.withName(name);
    }

    return projection as IReadModelProjector<R, T>;
  }
}
