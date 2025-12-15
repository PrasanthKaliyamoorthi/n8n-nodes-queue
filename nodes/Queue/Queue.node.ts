
import type {
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

/**
 * One queued item
 */
interface QueueEntry {
  key: string;
  data: INodeExecutionData;
  timestamp: number;
}

/**
 * Per-key queue state (used in multi mode)
 */
interface KeyQueueState {
  queue: QueueEntry[];
  locked: boolean;
}

/**
 * Workflow static data shape
 */
interface QueueStaticData {
  // single mode
  queue?: QueueEntry[];
  locked?: boolean;

  // multi mode
  queues?: Record<string, KeyQueueState>;
}

export class Queue implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Queue',
    name: 'queue',
    icon: { light: 'file:queue.svg', dark: 'file:queue.dark.svg' },
    group: ['input'],
    version: 1,
    description: 'FIFO queue / mutex for workflow concurrency control',
    defaults: {
      name: 'Queue',
    },
    inputs: [NodeConnectionTypes.Main, NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    usableAsTool: true,
    properties: [
      {
        displayName: 'Key',
        name: 'key',
        type: 'string',
        default: '',
        description: 'Queue / lock key',
      },
      {
        displayName: 'Mode',
        name: 'mode',
        type: 'options',
        default: 'modeSingle',
        options: [
          { name: 'Single Queue Mode', value: 'modeSingle' },
          { name: 'Multi Queue Mode', value: 'modeMulti' },
        ],
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const mode = this.getNodeParameter('mode', 0) as 'modeSingle' | 'modeMulti';

    const dataInput = this.getInputData(0);
    const signalInput = this.getInputData(1);

    const staticData = this.getWorkflowStaticData('global') as unknown as QueueStaticData;

    const output: INodeExecutionData[] = [];

    /* =====================================================
       INITIALIZATION
    ===================================================== */

    if (mode === 'modeSingle') {
      staticData.queue ??= [];
      staticData.locked ??= false;
    }

    if (mode === 'modeMulti') {
      staticData.queues ??= {};
    }

    /* =====================================================
       DATA INPUT → ENQUEUE (LOCK REQUEST)
    ===================================================== */

    for (let i = 0; i < dataInput.length; i++) {
      const key = this.getNodeParameter('key', i) as string;

      const entry: QueueEntry = {
        key,
        data: dataInput[i],
        timestamp: Date.now(),
      };

      if (mode === 'modeSingle') {
        staticData.queue!.push(entry);
      }

      if (mode === 'modeMulti') {
        staticData.queues![key] ??= { queue: [], locked: false };
        staticData.queues![key].queue.push(entry);
      }
    }

    /* =====================================================
       AUTO-RELEASE FRONT ITEM (IF UNLOCKED)
    ===================================================== */

    if (mode === 'modeSingle') {
      if (!staticData.locked && staticData.queue!.length > 0) {
        staticData.locked = true;
        const front = staticData.queue![0];
        output.push({ ...front.data });
      }
    }

    if (mode === 'modeMulti') {
      for (const key of Object.keys(staticData.queues!)) {
        const state = staticData.queues![key];
        if (!state.locked && state.queue.length > 0) {
          state.locked = true;
          output.push({ ...state.queue[0].data });
        }
      }
    }

    /* =====================================================
       SIGNAL INPUT → UNLOCK
    ===================================================== */

    for (let i = 0; i < signalInput.length; i++) {
      const signalKey = signalInput[i].json?.key as string;
      if (!signalKey) continue;

      // ---------- SINGLE MODE ----------
      if (mode === 'modeSingle') {
        const q = staticData.queue!;
        if (!q.length) continue;

        if (q[0].key === signalKey) {
          q.shift();                 // remove completed
          staticData.locked = false;

          if (q.length > 0) {
            staticData.locked = true;
            output.push({ ...q[0].data });
          }
        }
      }

      // ---------- MULTI MODE ----------
      if (mode === 'modeMulti') {
        const state = staticData.queues![signalKey];
        if (!state || !state.queue.length) continue;

        state.queue.shift();          // remove completed
        state.locked = false;

        if (state.queue.length > 0) {
          state.locked = true;
          output.push({ ...state.queue[0].data });
        } else {
          delete staticData.queues![signalKey];
        }
      }
    }

    return [output];
  }
}
