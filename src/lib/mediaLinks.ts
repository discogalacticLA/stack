/**
 * External listening links. Only YouTube is supported in this milestone.
 * We store the validated video id, never arbitrary URLs or embed HTML.
 */
const ID = /^[A-Za-z0-9_-]{11}$/;

export function parseYouTubeId(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.replace(/^www\.|^m\.|^music\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = url.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else {
      const m = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(url.pathname);
      id = m ? m[1] : null;
    }
  }
  return id && ID.test(id) ? id : null;
}

export const youtubeWatchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;
export const youtubeEmbedUrl = (id: string) => `https://www.youtube-nocookie.com/embed/${id}?rel=0`;

export interface MediaLinkLine { track_position: string | null; external_id: string }

/** One per line: "https://youtu.be/…" (whole record) or "A1 | https://youtu.be/…" (a track). */
export function parseMediaLinkLines(text: string): MediaLinkLine[] {
  const out: MediaLinkLine[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const parts = line.split("|").map((s) => s.trim());
    const [pos, url] = parts.length >= 2 ? [parts[0] || null, parts[1]] : [null, parts[0]];
    const id = parseYouTubeId(url);
    if (!id) throw new Error(`Listening link line ${i + 1}: use a YouTube URL like https://www.youtube.com/watch?v=… (optionally “A1 | URL”).`);
    out.push({ track_position: pos ? pos.slice(0, 10) : null, external_id: id });
  });
  if (out.length > 20) throw new Error("Add at most 20 listening links per edition.");
  return out;
}

export function serializeMediaLinks(links: MediaLinkLine[]): string {
  return links.map((l) => (l.track_position ? `${l.track_position} | ` : "") + youtubeWatchUrl(l.external_id)).join("\n");
}
