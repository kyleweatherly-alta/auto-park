import { useSyncExternalStore } from "react";

export type Route =
  | { name: "home" }
  | { name: "settings" }
  | { name: "history" }
  | { name: "run"; id: string };

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  const [first, second] = path.split("/");
  if (first === "settings") return { name: "settings" };
  if (first === "history") return { name: "history" };
  if (first === "run" && second) return { name: "run", id: second };
  return { name: "home" };
}

const subscribe = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseHash(hash);
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const hash = to.startsWith("#") ? to : `#${to}`;
  if (opts.replace) {
    history.replaceState(null, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = hash;
  }
}
