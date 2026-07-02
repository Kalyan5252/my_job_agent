export interface PipelineEvent<TPayload = Record<string, unknown>> {
  type: string;
  emittedAt: string;
  payload: TPayload;
}

export interface PipelineEventBus {
  emit<TPayload>(event: PipelineEvent<TPayload>): Promise<void>;
}

export class NoopPipelineEventBus implements PipelineEventBus {
  async emit<TPayload>(_event: PipelineEvent<TPayload>): Promise<void> {}
}

export class InMemoryPipelineEventBus implements PipelineEventBus {
  readonly events: PipelineEvent[] = [];

  async emit<TPayload>(event: PipelineEvent<TPayload>): Promise<void> {
    this.events.push(event as PipelineEvent);
  }
}

export class ConsolePipelineEventBus implements PipelineEventBus {
  async emit<TPayload>(event: PipelineEvent<TPayload>): Promise<void> {
    console.log(`[event] ${event.type}`, JSON.stringify(event.payload));
  }
}
