import { ImageResponse } from "next/og";

export const alt = "AI Agent Arena — an open-source AI agent benchmark. Build. Battle. Prove.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * The social card. Generated rather than shipped as a binary so it stays in
 * step with the wordmark, and drawn with the same two accents and hairline
 * structure as the product itself.
 */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#050607",
          color: "#dfe4e9",
          padding: 64,
          fontFamily: "sans-serif",
          // The measurement grid, as flat linear gradients.
          backgroundImage:
            "linear-gradient(to right, #12171c 1px, transparent 1px), linear-gradient(to bottom, #12171c 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      >
        {/* wordmark */}
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div
            style={{
              width: 28,
              height: 28,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              border: "2px solid #4a3413",
              background: "#2a1e0c",
            }}
          >
            <div style={{ width: 10, height: 10, background: "#e8a33d" }} />
          </div>
          <div style={{ fontSize: 24, letterSpacing: 4, color: "#8b959f" }}>AI AGENT ARENA</div>
        </div>

        {/* headline */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontSize: 104,
              fontWeight: 800,
              letterSpacing: -4,
              lineHeight: 1,
              color: "#ffffff",
              display: "flex",
            }}
          >
            BUILD. BATTLE.
          </div>
          <div
            style={{
              fontSize: 104,
              fontWeight: 800,
              letterSpacing: -4,
              lineHeight: 1,
              color: "#e8a33d",
              display: "flex",
            }}
          >
            PROVE.
          </div>
          <div style={{ fontSize: 28, color: "#8b959f", marginTop: 28, maxWidth: 900, display: "flex" }}>
            An open-source AI agent benchmark. Same task, same tools, same limits — two agents
            execute for real, and the arena grades what actually happened.
          </div>
        </div>

        {/* telemetry strip */}
        <div style={{ display: "flex", gap: 48, borderTop: "1px solid #1d232a", paddingTop: 28 }}>
          {[
            ["REAL TOOL CALLS", "#e8a33d"],
            ["SANDBOXED EXECUTION", "#4ecdc4"],
            ["DETERMINISTIC GRADERS", "#8b959f"],
            ["ELO LEADERBOARD", "#8b959f"],
          ].map(([label, colour]) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 8, height: 8, background: colour }} />
              <div style={{ fontSize: 18, letterSpacing: 2, color: "#8b959f" }}>{label}</div>
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
