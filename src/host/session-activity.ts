import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  CompactionTask, GenerationTask,
  type ConversationId, type Harness, type TaskGraph, type TaskGraphNode,
} from "@earendil-works/pi-durable";
import type { Selection, SessionActivity } from "../shared/api.js";

type Activity = Omit<SessionActivity, keyof Selection>;

export class SessionActivities {
  private readonly states = new Map<ConversationId, Activity>();
  private readonly listeners = new Set<(items: SessionActivity[]) => void>();
  private live = new Map<ConversationId, TaskGraphNode>();
  private detachGraph?: () => void;

  constructor(private readonly selectionOf: (id: ConversationId) => Selection | undefined) {}

  async attach(harness: Harness) {
    const queued: TaskGraph[] = [];
    let ready = false;
    let scheduled = false;
    let active = true;
    const drain = () => {
      scheduled = false;
      if (!active || !ready) return;
      for (const graph of queued.splice(0)) this.advance(harness, graph, () => active);
    };
    // Unlike a folded watch, the observer sees short runs that start and
    // finish while a listener is busy. Only enqueue inside Durable's commit.
    const observation = await harness.observeTaskGraph({
      advance(call) {
        if (call.kind !== "value") return;
        queued.push(call.value);
        if (!scheduled) {
          scheduled = true;
          queueMicrotask(drain);
        }
      },
      end() { active = false; },
    }, BACKGROUND_CONTEXT);
    this.detachGraph = () => {
      active = false;
      queued.length = 0;
      observation.detach();
    };
    ready = true;
    queued.unshift(observation.value);
    drain();
  }

  detach() {
    this.detachGraph?.();
    this.detachGraph = undefined;
    let changed = false;
    for (const [id, state] of this.states) {
      if (!state.settled) changed = this.states.delete(id) || changed;
    }
    this.live.clear();
    if (changed) this.publish();
  }

  forget(ids: readonly ConversationId[]) {
    let changed = false;
    for (const id of ids) changed = this.states.delete(id) || changed;
    if (changed) this.publish();
  }

  read(id: ConversationId, taskId: number) {
    const state = this.states.get(id);
    if (state?.taskId === taskId && state.settled) {
      this.states.delete(id);
      this.publish();
    }
  }

  subscribe(listener: (items: SessionActivity[]) => void) {
    listener(this.snapshot());
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private snapshot() {
    return Array.from(this.states, ([id, activity]) => {
      const selection = this.selectionOf(id);
      return selection && { ...selection, ...activity };
    }).filter((item): item is SessionActivity => item !== undefined);
  }

  private publish() {
    if (!this.listeners.size) return;
    const items = this.snapshot();
    for (const listener of this.listeners) listener(items);
  }

  private advance(harness: Harness, graph: TaskGraph, active: () => boolean) {
    const next = new Map<ConversationId, TaskGraphNode>();
    for (const task of Object.values(graph.tasks)) {
      if (task.owner !== undefined || task.background ||
          (task.kind !== GenerationTask.definition.name && task.kind !== CompactionTask.definition.name)) continue;
      const current = next.get(task.conversationId);
      if (!current || current.id < task.id) next.set(task.conversationId, task);
    }
    const previous = this.live;
    this.live = next;
    let changed = false;
    for (const [id, task] of next) {
      const state = task.blocked ? "attention" : "running";
      const prior = this.states.get(id);
      if (prior?.taskId === task.id && prior.state === state && !prior.settled) continue;
      this.states.set(id, { state, taskId: task.id, settled: false });
      changed = true;
    }
    if (changed) this.publish();
    for (const [id, task] of previous) {
      if (next.has(id)) continue;
      const settle = (state?: Activity["state"]) => {
        if (!active() || this.live.has(id) || this.states.get(id)?.taskId !== task.id) return;
        if (state) this.states.set(id, { state, taskId: task.id, settled: true });
        else this.states.delete(id);
        this.publish();
      };
      void harness.getTask(task.id, BACKGROUND_CONTEXT).then(receipt => {
        const outcome = receipt?.state.status === "terminal" ? receipt.state.outcome.status : undefined;
        settle(outcome === "completed" ? "finished" : outcome && outcome !== "aborted" ? "attention" : undefined);
      }, () => settle());
    }
  }
}
