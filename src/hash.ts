export const sha256Hex = (s: string): string => new Bun.CryptoHasher("sha256").update(s).digest("hex");
