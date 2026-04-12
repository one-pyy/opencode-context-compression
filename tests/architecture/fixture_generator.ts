export type Role = "user" | "assistant" | "system";

export interface MessageInfo {
  role: Role;
  id: string;
  sessionID: string;
  parentID?: string;
  time?: { created: number; completed?: number };
}

export interface TextPart {
  type: "text";
  id: string;
  messageID: string;
  text: string;
}

export interface ToolPart {
  type: "tool";
  id: string;
  messageID: string;
  tool: string;
  callID: string;
  state: {
    status: "pending" | "executing" | "completed" | "error";
    input: any;
    output?: any;
  };
}

export type MessagePart = TextPart | ToolPart | { type: "step-start" | "step-finish" | "reasoning" };

export interface CanonicalMessage {
  info: MessageInfo;
  parts: MessagePart[];
}

let msgCounter = 1;
let prtCounter = 1;

export function createSession(sessionID: string = "ses_test") {
  return {
    createUserMessage(text: string): CanonicalMessage {
      const msgID = `msg_${msgCounter++}`;
      return {
        info: { role: "user", id: msgID, sessionID },
        parts: [{ type: "text", id: `prt_${prtCounter++}`, messageID: msgID, text }]
      };
    },
    
    createAssistantMessage(text?: string, tools?: ToolPart[]): CanonicalMessage {
      const msgID = `msg_${msgCounter++}`;
      const parts: MessagePart[] = [];
      if (text) {
        parts.push({ type: "text", id: `prt_${prtCounter++}`, messageID: msgID, text });
      }
      if (tools) {
        parts.push(...tools);
      }
      return {
        info: { role: "assistant", id: msgID, sessionID },
        parts
      };
    },

    createMarkTool(callID: string, mode: "compact" | "delete", targetRange: { startVisibleMessageID: string, endVisibleMessageID: string }, markIdResult?: string | Error): ToolPart {
      return {
        type: "tool",
        id: `prt_${prtCounter++}`,
        messageID: "", // populated by createAssistantMessage
        tool: "compression_mark",
        callID,
        state: {
          status: markIdResult instanceof Error ? "error" : "completed",
          input: { contractVersion: "v1", mode, target: targetRange },
          output: markIdResult instanceof Error ? markIdResult.message : markIdResult
        }
      };
    }
  };
}
