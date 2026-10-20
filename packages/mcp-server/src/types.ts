import type { Channel, Session, StreamMessage } from '@nulth/sdk';

export interface OpenSession {
  session: Session;
  channel: Channel;
  /** Cached async iterator for the active stream, reused across stream_session calls. */
  streamIterator?: AsyncIterator<StreamMessage>;
  /** Whether the cached stream iterator has been exhausted or disposed. */
  streamClosed?: boolean;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}
