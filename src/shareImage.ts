// Turns a session's standings into a shareable PNG "results card" -- used by
// the "Share results" button on both HostSession.tsx and
// ParticipantSession.tsx's RankingTab (identical copies of that tab live in
// both files; this module is shared rather than duplicated a third time).
//
// Design: reuses this app's existing dark "achievement" look (the same
// black-to-dark-brown radial vignette as .rank-badge-card in styles.css) and
// its egg-to-chicken LEVEL_ICON set, so a shared card reads as the same app
// as the Rank tab. The canvas height is NOT fixed -- it's measured from the
// actual content first (podium + awards + however many standings rows fit),
// so a 2-player pickup game gets a short, tight card instead of a mile of
// empty space, and a big roster gets a taller one instead of being cut off.
// Only a very large roster (12+ players outside the podium) gets truncated
// with a "+N more players" line, so the image never grows unreasonably tall.
import { LEVEL_ICON, type Player } from "./api";

export interface ShareAwards {
  mostGames: Player[];
  bestDiff: Player;
  streakPlayers: Player[];
  streakValue: number;
}

export interface ResultsImageData {
  sessionName: string;
  dateLabel: string;
  // Already sorted by rank (best first) -- callers already compute this for
  // the on-screen podium/table, so this module doesn't re-derive it.
  sorted: Player[];
  awards: ShareAwards | null;
}

const WIDTH = 1080;
const MARGIN = 64;
const CONTENT_W = WIDTH - MARGIN * 2;
const FOOTER_H = 92;
const MAX_REST_ROWS = 12; // beyond this we truncate with "+N more" instead of growing forever

const COLORS = {
  gold: "#ffc233",
  goldLight: "#ffe066",
  goldDeep: "#ffcc33",
  silverLight: "#f0f1f3",
  silverDeep: "#c9ced6",
  bronzeLight: "#f3cd9e",
  bronzeDeep: "#d6924f",
  white: "#ffffff",
  muted: "#d8cdbe",
  mutedDim: "#a9957a",
  good: "#5fd068",
  bad: "#ff6b6b",
  cardFill: "rgba(255,255,255,0.07)",
  cardBorder: "rgba(255,255,255,0.14)",
  divider: "rgba(255,255,255,0.10)",
};

const FONT = '"Fredoka", sans-serif';

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function truncateToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = text.slice(0, mid) + "…";
    if (ctx.measureText(candidate).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + "…";
}

// Greedy word-wrap capped at maxLines; the last line gets an ellipsis if more text remains.
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    } else {
      line = test;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines) {
    const consumed = lines.join(" ").split(/\s+/).length;
    if (consumed < words.length) {
      let last = lines[maxLines - 1];
      while (ctx.measureText(last + "…").width > maxWidth && last.length > 0) {
        last = last.slice(0, -1);
      }
      lines[maxLines - 1] = last.trimEnd() + "…";
    }
  }
  return lines;
}

function drawAvatar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  d: number,
  gradStops: [string, string],
  level: Player["level"],
) {
  const r = d / 2;
  const grad = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
  grad.addColorStop(0, gradStops[0]);
  grad.addColorStop(1, gradStops[1]);
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 4;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${Math.round(d * 0.46)}px ${FONT}`;
  ctx.fillText(LEVEL_ICON[level] ?? "🐔", cx, cy + 2);
}

function drawPodiumColumn(
  ctx: CanvasRenderingContext2D,
  opts: { xLeft: number; width: number; standBottomY: number; place: 1 | 2 | 3; player: Player | undefined },
) {
  const { xLeft, width, standBottomY, place, player } = opts;
  if (!player) return;
  const isGold = place === 1;
  const isSilver = place === 2;
  const cx = xLeft + width / 2;
  const avatarD = isGold ? 110 : 90;
  const standH = isGold ? 116 : isSilver ? 86 : 64;
  const crownH = isGold ? 48 : 0;
  const crownGap = isGold ? 8 : 0;
  const nameH = 34;
  const recordH = 25;
  const gapAvatarName = 14;
  const gapNameRecord = 6;
  const gapRecordStand = 12;

  const colHeight = crownH + crownGap + avatarD + gapAvatarName + nameH + gapNameRecord + recordH + gapRecordStand + standH;
  let y = standBottomY - colHeight;

  if (isGold) {
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.font = "40px serif";
    ctx.fillText("👑", cx, y + crownH * 0.8);
    y += crownH + crownGap;
  }

  const avatarCy = y + avatarD / 2;
  const gradStops: [string, string] = isGold
    ? [COLORS.goldLight, COLORS.goldDeep]
    : isSilver
      ? [COLORS.silverLight, COLORS.silverDeep]
      : [COLORS.bronzeLight, COLORS.bronzeDeep];
  drawAvatar(ctx, cx, avatarCy, avatarD, gradStops, player.level);
  y += avatarD + gapAvatarName;

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = `700 31px ${FONT}`;
  ctx.fillStyle = COLORS.white;
  const streakTag = player.currentStreak >= 3 ? " 🔥" : "";
  const nameLabel = truncateToWidth(ctx, player.name, width - 12) + streakTag;
  ctx.fillText(nameLabel, cx, y + nameH * 0.78);
  y += nameH + gapNameRecord;

  ctx.font = `500 23px ${FONT}`;
  ctx.fillStyle = COLORS.muted;
  const winPct = player.gamesPlayed ? Math.round((player.wins / player.gamesPlayed) * 100) : 0;
  ctx.fillText(`${player.wins}-${player.losses} · ${winPct}%`, cx, y + recordH * 0.8);
  y += recordH + gapRecordStand;

  const standGrad = ctx.createLinearGradient(xLeft, y, xLeft, y + standH);
  if (isGold) {
    standGrad.addColorStop(0, COLORS.goldLight);
    standGrad.addColorStop(1, COLORS.gold);
  } else if (isSilver) {
    standGrad.addColorStop(0, COLORS.silverLight);
    standGrad.addColorStop(1, COLORS.silverDeep);
  } else {
    standGrad.addColorStop(0, COLORS.bronzeLight);
    standGrad.addColorStop(1, COLORS.bronzeDeep);
  }
  roundRect(ctx, xLeft, y, width, standH, 14);
  ctx.fillStyle = standGrad;
  ctx.fill();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `800 32px ${FONT}`;
  ctx.fillStyle = "#4a3200";
  ctx.fillText(String(place), cx, y + standH / 2 + 2);
}

// Draws everything except the background + footer, starting just below the
// top margin, and returns the y position right after the last section (i.e.
// the content height before the footer gets appended). Called twice: once on
// a throwaway canvas purely to measure that final y, then again on the real,
// correctly-sized canvas to actually draw -- see buildResultsImageBlob.
function drawContent(ctx: CanvasRenderingContext2D, data: ResultsImageData): number {
  const { sessionName, dateLabel, sorted, awards } = data;
  let y = 72;

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = `700 28px ${FONT}`;
  ctx.fillStyle = COLORS.gold;
  ctx.fillText("🏸  S M A S H I L O G", WIDTH / 2, y);
  y += 52;

  ctx.font = `700 58px ${FONT}`;
  ctx.fillStyle = COLORS.white;
  const titleLines = wrapLines(ctx, sessionName, CONTENT_W, 2);
  for (const line of titleLines) {
    ctx.fillText(line, WIDTH / 2, y);
    y += 66;
  }

  ctx.font = `500 27px ${FONT}`;
  ctx.fillStyle = COLORS.muted;
  ctx.fillText(dateLabel, WIDTH / 2, y);
  y += 54;

  const top3 = sorted.slice(0, 3);
  if (top3.length > 0) {
    const colGap = 48;
    const colWidth = (CONTENT_W - colGap * 2) / 3;
    const col2x = MARGIN;
    const col1x = MARGIN + colWidth + colGap;
    const col3x = MARGIN + (colWidth + colGap) * 2;
    const standBottomY = y + 352;
    drawPodiumColumn(ctx, { xLeft: col2x, width: colWidth, standBottomY, place: 2, player: top3[1] });
    drawPodiumColumn(ctx, { xLeft: col1x, width: colWidth, standBottomY, place: 1, player: top3[0] });
    drawPodiumColumn(ctx, { xLeft: col3x, width: colWidth, standBottomY, place: 3, player: top3[2] });
    y = standBottomY + 36;
  }

  if (awards) {
    const rows: { icon: string; label: string; value: string }[] = [];
    const diffVal = (awards.bestDiff.pointsFor - awards.bestDiff.pointsAgainst) / awards.bestDiff.gamesPlayed;
    rows.push({
      icon: "📈",
      label: "Best point diff",
      value: `${awards.bestDiff.name} (${diffVal > 0 ? "+" : ""}${diffVal.toFixed(1)})`,
    });
    rows.push({
      icon: "🎽",
      label: "Most games played",
      value: `${awards.mostGames.map((p) => p.name).join(", ")} (${awards.mostGames[0].gamesPlayed})`,
    });
    if (awards.streakPlayers.length > 0) {
      rows.push({
        icon: "🔥",
        label: "Longest win streak",
        value: `${awards.streakPlayers.map((p) => p.name).join(", ")} (${awards.streakValue})`,
      });
    }

    const padX = 34;
    const padTop = 28;
    const padBottom = 20;
    const headerH = 38;
    const rowH = 50;
    const cardH = padTop + headerH + rows.length * rowH + padBottom;
    roundRect(ctx, MARGIN, y, CONTENT_W, cardH, 24);
    ctx.fillStyle = COLORS.cardFill;
    ctx.fill();
    ctx.strokeStyle = COLORS.cardBorder;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    let ry = y + padTop + headerH * 0.72;
    ctx.textAlign = "left";
    ctx.font = `700 27px ${FONT}`;
    ctx.fillStyle = COLORS.goldLight;
    ctx.fillText("🏆 SESSION AWARDS", MARGIN + padX, ry);
    ry += headerH + 2;

    for (const row of rows) {
      ctx.font = `500 25px ${FONT}`;
      ctx.fillStyle = COLORS.muted;
      ctx.textAlign = "left";
      ctx.fillText(`${row.icon}  ${row.label}`, MARGIN + padX, ry);

      ctx.font = `700 25px ${FONT}`;
      ctx.fillStyle = COLORS.white;
      ctx.textAlign = "right";
      const maxValW = CONTENT_W - padX * 2 - 300;
      ctx.fillText(truncateToWidth(ctx, row.value, maxValW), MARGIN + CONTENT_W - padX, ry);
      ry += rowH;
    }

    y += cardH + 32;
  }

  const rest = sorted.slice(3);
  if (rest.length > 0) {
    ctx.textAlign = "left";
    ctx.font = `700 25px ${FONT}`;
    ctx.fillStyle = COLORS.gold;
    const allShown = rest.length <= MAX_REST_ROWS;
    ctx.fillText(allShown ? "FULL STANDINGS" : "STANDINGS", MARGIN, y);
    y += 18;

    const rowH = 54;
    const padTop = 14;
    const padBottom = 14;
    let shown = rest;
    let overflowNote: string | null = null;
    if (rest.length > MAX_REST_ROWS) {
      shown = rest.slice(0, MAX_REST_ROWS - 1);
      overflowNote = `+ ${rest.length - shown.length} more players`;
    }

    const rowsToDraw = shown.length + (overflowNote ? 1 : 0);
    const cardH = padTop + padBottom + rowsToDraw * rowH;
    roundRect(ctx, MARGIN, y, CONTENT_W, cardH, 24);
    ctx.fillStyle = COLORS.cardFill;
    ctx.fill();
    ctx.strokeStyle = COLORS.cardBorder;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    let ry = y + padTop;
    shown.forEach((p, i) => {
      const rank = i + 4;
      const winPct = p.gamesPlayed ? Math.round((p.wins / p.gamesPlayed) * 100) : 0;
      const diff = p.gamesPlayed ? (p.pointsFor - p.pointsAgainst) / p.gamesPlayed : 0;

      if (i > 0) {
        ctx.strokeStyle = COLORS.divider;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(MARGIN + 28, ry);
        ctx.lineTo(MARGIN + CONTENT_W - 28, ry);
        ctx.stroke();
      }

      const midY = ry + rowH / 2 + 9;
      ctx.textAlign = "left";
      ctx.font = `600 25px ${FONT}`;
      ctx.fillStyle = COLORS.mutedDim;
      ctx.fillText(String(rank), MARGIN + 28, midY);

      ctx.font = `600 26px ${FONT}`;
      ctx.fillStyle = COLORS.white;
      const streakTag = p.currentStreak >= 3 ? " 🔥" : "";
      ctx.fillText(truncateToWidth(ctx, p.name, 300) + streakTag, MARGIN + 70, midY);

      ctx.textAlign = "right";
      ctx.font = `500 24px ${FONT}`;
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(`${p.wins}-${p.losses} · ${winPct}%`, MARGIN + CONTENT_W - 178, midY);

      ctx.font = `700 24px ${FONT}`;
      ctx.fillStyle = diff > 0 ? COLORS.good : diff < 0 ? COLORS.bad : COLORS.muted;
      ctx.fillText(diff > 0 ? `+${diff.toFixed(1)}` : diff.toFixed(1), MARGIN + CONTENT_W - 28, midY);

      ry += rowH;
    });

    if (overflowNote) {
      if (shown.length > 0) {
        ctx.strokeStyle = COLORS.divider;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(MARGIN + 28, ry);
        ctx.lineTo(MARGIN + CONTENT_W - 28, ry);
        ctx.stroke();
      }
      ctx.textAlign = "center";
      ctx.font = `500 23px ${FONT}`;
      ctx.fillStyle = COLORS.mutedDim;
      ctx.fillText(overflowNote, WIDTH / 2, ry + rowH / 2 + 9);
    }

    y += cardH;
  }

  return y;
}

function paintBackground(ctx: CanvasRenderingContext2D, width: number, height: number) {
  // Same black-center-to-dark-brown-edge vignette as .rank-badge-card in
  // styles.css, per the app's established "achievement card" look.
  const bgGrad = ctx.createRadialGradient(width / 2, height * 0.3, 60, width / 2, height * 0.3, height * 1.05);
  bgGrad.addColorStop(0, "#000000");
  bgGrad.addColorStop(0.4, "#000000");
  bgGrad.addColorStop(0.78, "#2a1709");
  bgGrad.addColorStop(1, "#3c230f");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);
}

function paintFooter(ctx: CanvasRenderingContext2D, width: number, height: number) {
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.font = `500 23px ${FONT}`;
  ctx.fillStyle = COLORS.mutedDim;
  ctx.fillText("🏸 Shared from Smashilog", width / 2, height - 38);
}

// The webfont needs to actually be loaded before we measure/draw text with
// it, or canvas silently falls back to a system sans-serif for the first
// render (index.html already <link>s Fredoka for the rest of the app, but
// loading it doesn't mean it's *ready* yet the first time this runs).
async function ensureFontReady() {
  try {
    await Promise.all([
      document.fonts.load(`800 60px ${FONT}`),
      document.fonts.load(`700 40px ${FONT}`),
      document.fonts.load(`500 26px ${FONT}`),
    ]);
    await document.fonts.ready;
  } catch {
    // Offline or blocked -- canvas falls back to a system sans-serif, which
    // still reads fine, just slightly less on-brand.
  }
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not render the image"))), "image/png");
  });
}

// Measures content on a throwaway canvas, then draws the real image onto a
// canvas sized to fit exactly -- see the module comment up top for why.
export async function buildResultsImageBlob(data: ResultsImageData): Promise<Blob> {
  await ensureFontReady();

  const measure = document.createElement("canvas");
  measure.width = WIDTH;
  measure.height = 4000; // generous scratch space, never shown
  const measureCtx = measure.getContext("2d");
  if (!measureCtx) throw new Error("Canvas not supported");
  const contentBottomY = drawContent(measureCtx, data);

  const height = Math.max(760, Math.round(contentBottomY + FOOTER_H));
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  paintBackground(ctx, WIDTH, height);
  drawContent(ctx, data);
  paintFooter(ctx, WIDTH, height);

  return canvasToPngBlob(canvas);
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "session";
}

// Builds the results image and shares it as a file where the platform
// supports that (Web Share API Level 2 -- modern mobile Safari/Chrome, which
// covers sharing straight into WhatsApp/Messenger/etc.), falling back to
// downloading the PNG so it can still be attached manually everywhere else.
export async function shareResultsImage(data: ResultsImageData, onStatus: (msg: string) => void): Promise<void> {
  let blob: Blob;
  try {
    blob = await buildResultsImageBlob(data);
  } catch {
    onStatus("Couldn't create the results image — try again.");
    return;
  }

  const fileName = `${slugify(data.sessionName)}-results.png`;
  const file = new File([blob], fileName, { type: "image/png" });
  const shareTitle = `${data.sessionName} results`;
  const shareText = `🏸 ${data.sessionName} — results`;

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: shareTitle, text: shareText });
      return;
    } catch {
      // Cancelled by the user -- leave it there, same as the old text-share behavior.
      return;
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  onStatus("Image downloaded — share it from your gallery!");
}
