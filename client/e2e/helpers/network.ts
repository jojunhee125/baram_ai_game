import type { Page } from "@playwright/test";

export interface CapturedFrame {
  readonly atMs: number; // performance.now() 기준 관측 시각
  readonly byteLength: number;
  readonly direction: "sent" | "received";
}

export interface WebSocketCapture {
  readonly frames: readonly CapturedFrame[];
  stop(): void;
}

/**
 * 이 호출 이후 열리는 Colyseus WS 연결의 모든 프레임 타임스탬프·바이트 길이를 기록한다
 * (room 조인 전에 호출). Playwright의 `framesent`/`framereceived`를 그대로 쓰고 프레임을
 * 다시 디코딩하지 않는다 — 필요한 건 케이던스(예: F-6 #1 "Attack 프레임 간격이 브라우저 키
 * 리피트가 아니라 ATTACK_COOLDOWN_MS에 수렴하는가")지 스키마 와이어 포맷 파싱이 아니다.
 * 관심 메시지는 바이트 길이 시그니처로 구분한다(한 번 수동으로 스윙 1회를 캡처해 길이를
 * 알아두거나, 그 구간에는 그 메시지만 나가도록 다른 입력을 멈춘 채 측정).
 */
export function captureWebSocketFrames(page: Page): WebSocketCapture {
  const frames: CapturedFrame[] = [];

  const handleWebSocket = (ws: import("@playwright/test").WebSocket): void => {
    ws.on("framesent", (payload) => {
      frames.push({
        atMs: performance.now(),
        byteLength: byteLengthOf(payload.payload),
        direction: "sent",
      });
    });
    ws.on("framereceived", (payload) => {
      frames.push({
        atMs: performance.now(),
        byteLength: byteLengthOf(payload.payload),
        direction: "received",
      });
    });
  };

  page.on("websocket", handleWebSocket);

  return {
    frames,
    stop: () => {
      page.off("websocket", handleWebSocket);
    },
  };
}

function byteLengthOf(payload: string | Buffer): number {
  return typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength;
}
