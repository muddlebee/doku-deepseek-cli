export type AppView = "chat" | "session-list" | "undo" | "mcp-status" | "web-search-setup";

export type ViewTransition = { type: "open"; view: Exclude<AppView, "chat"> } | { type: "close" };

export function transitionView(_current: AppView, transition: ViewTransition): AppView {
  return transition.type === "open" ? transition.view : "chat";
}
