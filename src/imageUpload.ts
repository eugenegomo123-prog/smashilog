// Reads a selected photo, center-crops it to a square, and shrinks it to
// size×size -- keeps the uploaded data: URL small (a few tens of KB) without
// asking a non-technical host or player to resize anything themselves. Used
// by the Account tab's profile-picture upload (PlayerHome.tsx) -- the one
// place in the app a picture is set (see accounts.profilePicture in
// db/schema.ts).
export async function compressImageFile(file: File, size = 320): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read that file"));
    reader.readAsDataURL(file);
  });
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("That doesn't look like an image"));
    img.src = dataUrl;
  });
  const side = Math.min(img.width, img.height);
  const sx = (img.width - side) / 2;
  const sy = (img.height - side) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not process that image");
  ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
  return canvas.toDataURL("image/jpeg", 0.82);
}
