/**
 * Links people share (posts, profiles). They use the official address once
 * VITE_PUBLIC_ORIGIN is set (https://amigoworld.com.ng); until then, the address
 * the app is open on — so nobody is sent to a new address (with its own browser
 * storage, i.e. a new messaging device) before that move is ready.
 */
const official = ((import.meta.env.VITE_PUBLIC_ORIGIN as string | undefined) ?? "").replace(/\/+$/, "");

export const publicUrl = (path: string) => `${official || location.origin}${path}`;
