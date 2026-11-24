const STORAGE_KEY = "home_prompt_transition";
export const PROMPT_TRANSITION_DURATION = 650;
export const NEW_CHAT_TRANSITION_ID = "new-chat";

export interface PromptPosition {
  top: number;
  left: number;
  width: number;
}

export interface PromptTransition {
  conversationId: string;
  position: PromptPosition;
  endsAt: number;
  startsOnMount?: boolean;
}

export function promptAnimationTime(): number {
  const time = typeof document === "undefined" ? null : document.timeline.currentTime;
  return typeof time === "number" ? time : performance.now();
}

export function promptPosition(element: HTMLElement): PromptPosition {
  const { top, left, width } = element.getBoundingClientRect();
  return { top, left, width };
}

export function savePromptTransition(transition: PromptTransition): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(transition));
}

export function clearPromptTransition(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}

export function prepareNewChatTransition(): void {
  preparePromptEntrance(NEW_CHAT_TRANSITION_ID, "conversation");
}

export function prepareConversationTransition(conversationId: string): void {
  preparePromptEntrance(conversationId, "home");
}

function preparePromptEntrance(conversationId: string, source: "home" | "conversation"): void {
  clearPromptTransition();
  const element = document.querySelector<HTMLElement>(`[data-chat-composer="${source}"]`);
  if (!element || element.getBoundingClientRect().width <= 0) return;
  // Allow route loading time; start the entrance when the destination mounts.
  savePromptTransition({ conversationId, position: promptPosition(element), endsAt: promptAnimationTime() + 10000, startsOnMount: true });
}

export function takePromptTransition(conversationId: string): PromptTransition | null {
  const stored = sessionStorage.getItem(STORAGE_KEY);
  clearPromptTransition();
  if (!stored) return null;
  try {
    const transition = JSON.parse(stored) as PromptTransition;
    const { position, endsAt } = transition;
    if (transition.conversationId !== conversationId ||
        !position || ![position.top, position.left, position.width, endsAt].every(Number.isFinite) ||
        position.width <= 0 || endsAt <= promptAnimationTime()) return null;
    return transition.startsOnMount
      ? { ...transition, endsAt: promptAnimationTime() + PROMPT_TRANSITION_DURATION, startsOnMount: false }
      : transition;
  } catch {
    return null;
  }
}

export function animatePromptPosition(element: HTMLElement, from: PromptPosition, duration: number, elapsed = 0): Animation | null {
  if (duration <= 0 || elapsed >= duration || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  const to = promptPosition(element);
  if (to.width <= 0) return null;
  const animation = element.animate([
    { transform: `translate3d(${from.left - to.left}px, ${from.top - to.top}px, 0) scaleX(${from.width / to.width})`, transformOrigin: "top left" },
    { transform: "translate3d(0, 0, 0) scaleX(1)", transformOrigin: "top left" },
  ], { duration, easing: "cubic-bezier(0.32, 0, 0.2, 1)" });
  // A route handoff resumes the same timeline and easing curve.
  animation.currentTime = Math.max(0, elapsed);
  if (typeof document !== "undefined" && typeof document.timeline.currentTime === "number") {
    animation.startTime = document.timeline.currentTime - Math.max(0, elapsed);
  }
  return animation;
}
