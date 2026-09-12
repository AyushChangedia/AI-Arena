import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

/** The arena mark: a single amber cell inside a measurement frame. */
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#050607",
          border: "2px solid #4a3413",
        }}
      >
        <div style={{ width: 10, height: 10, background: "#e8a33d" }} />
      </div>
    ),
    size,
  );
}
