import { defineConfig } from "@playwright/test";

const CODE_ROOT = "../.."; // client/e2e -> code/
const CLIENT_URL = "http://127.0.0.1:5173"; // localhost 아님 — vite.config.ts 프록시가 이미 겪은
                                             // IPv6 해석 함정과 같은 계열, 이 리포 관례를 따른다
const SERVER_PORT = 2567; // client/vite.config.ts의 프록시 타깃 & roomConnection.ts의
                           // DEV_SERVER_PORT에 하드코딩되어 있음 — 여기서 바꿀 수 없다

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1, // 모든 spec이 같은 서버 프로세스·같은 room 상태(사냥터 몬스터 등)를 공유한다.
              // 스펙이 늘어 서로 독립성이 검증되면 올릴 것 — 지금은 오탐 방지가 우선.
  reporter: [["list"]],
  use: {
    baseURL: CLIENT_URL,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      // `dev`(tsx watch)가 아니라 `start`(tsx 단발 실행) — 테스트 도중 파일 변경 감지로
      // 재시작하면 그 사이 연결된 클라이언트가 전부 끊긴다.
      command: "npm run start --workspace=@zep-test/server",
      cwd: CODE_ROOT,
      port: SERVER_PORT,
      reuseExistingServer: !process.env["CI"],
      timeout: 30_000,
      // DATABASE_URL 미설정 — 설계 §2.4의 "URL 없음 = 영속화 비활성" 모드 그대로 사용.
      // 이 스위트는 Postgres를 요구하지 않는다(스킨/인벤토리 영속을 검증하는 테스트가
      // 생기면 그때 ZEP_TEST_DATABASE_URL 같은 opt-in을 별도로 얹는다).
    },
    {
      // `--host 127.0.0.1` is required, not stylistic: on this project's Windows dev machines,
      // bare `vite` (no --host) binds only `[::1]` (IPv6 loopback) — verified empirically, the
      // Node 17+ getaddrinfo order change makes "localhost" resolve IPv6-first on Windows. Without
      // this flag, CLIENT_URL (127.0.0.1) never becomes reachable and every run times out at
      // webServer startup.
      command: "npm run dev --workspace=@zep-test/client -- --host 127.0.0.1",
      cwd: CODE_ROOT,
      url: CLIENT_URL,
      reuseExistingServer: !process.env["CI"],
      timeout: 30_000,
    },
  ],
});
