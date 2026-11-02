import { useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import type { HerdrTab, TabMoved } from "../../shared/protocol.ts";
import { adjacentTabBoundary, movedTabOrder, tabDropBoundary } from "./tabOrder.ts";

/** `before` / `after`: the drop key of the item the insertion line is drawn beside, in the dragged row */
type Drag = { tabId: string; boundary: number | null; before: string | null; after: string | null };
type Drop = Omit<Drag, "tabId">;
type Press = { tabId: string; pointerId: number; element: HTMLElement; x: number; y: number; startX: number; startY: number; started: boolean };
type Operation = { expected: string | null; settled: boolean; timer?: number };

/** A drag previews only an insertion line. Herdr's next snapshot owns the actual order. */
export function useTabReorder({ owner, tabs, strip, moveTab, failed, stale }: {
  owner: string;
  tabs: HerdrTab[];
  strip: RefObject<HTMLDivElement>;
  moveTab: (tabId: string, boundary: number) => Promise<TabMoved>;
  failed: (error: unknown) => void;
  stale: () => void;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [moving, setMoving] = useState(false);
  const ids = tabs.map((tab) => tab.tab_id);
  const key = JSON.stringify(ids);
  const current = useRef({ owner, key, ids, moveTab, failed, stale });
  current.current = { owner, key, ids, moveTab, failed, stale };
  const press = useRef<Press | null>(null);
  const operation = useRef<Operation | null>(null);
  const suppressClick = useRef(false);
  const animation = useRef<number | null>(null);

  const cancelDrag = (): void => {
    const held = press.current;
    press.current = null;
    if (held?.started) suppressClick.current = true;
    if (held?.element.hasPointerCapture(held.pointerId)) held.element.releasePointerCapture(held.pointerId);
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    animation.current = null;
    setDrag(null);
  };
  const finishOperation = (op: Operation): void => {
    if (operation.current !== op) return;
    if (op.timer !== undefined) window.clearTimeout(op.timer);
    operation.current = null;
    setMoving(false);
  };
  useLayoutEffect(() => {
    return () => {
      cancelDrag();
      const op = operation.current;
      if (op?.timer !== undefined) window.clearTimeout(op.timer);
      operation.current = null;
    };
  }, [owner]);
  useLayoutEffect(() => {
    cancelDrag();
    // An external create/close/reorder cancels a drag. A sent request still holds the gate
    // until the order in its answer has been observed. An unrelated snapshot received before
    // the answer is not an acknowledgement, and must not enable another stale-coordinate move.
    const op = operation.current;
    if (op?.settled && key === op.expected) finishOperation(op);
  }, [key, owner]);
  useLayoutEffect(() => {
    setMoving(false);
    suppressClick.current = false;
  }, [owner]);

  const requestMove = (tabId: string, boundary: number): void => {
    if (operation.current || !movedTabOrder(current.current.ids, tabId, boundary)) return;
    cancelDrag();
    const saved = current.current;
    const op: Operation = { expected: null, settled: false };
    operation.current = op;
    setMoving(true);
    void saved.moveTab(tabId, boundary).then((result) => {
      if (operation.current !== op || current.current.owner !== saved.owner) return;
      op.expected = JSON.stringify(result.tabs.map((tab) => tab.tab_id));
      op.settled = true;
      if (current.current.key === op.expected) finishOperation(op);
      // Concurrent native edits may supersede this order before it is published. Give the gate
      // a deadline and report that the expected snapshot never arrived rather than getting stuck.
      else op.timer = window.setTimeout(() => {
        if (operation.current !== op) return;
        finishOperation(op);
        current.current.stale();
      }, 8000);
    }).catch((reason: unknown) => {
      if (operation.current !== op || current.current.owner !== saved.owner) return;
      finishOperation(op);
      saved.failed(reason);
    });
  };
  const moveAdjacent = (tabId: string, direction: -1 | 1): void => {
    const boundary = adjacentTabBoundary(current.current.ids, tabId, direction);
    if (boundary !== null) requestMove(tabId, boundary);
  };
  // A tab drops within its own row: the strip, or an open tab group's row. A row's items need not
  // be herdr's tabs one for one (a group's chip stands for its tabs), so each item carries the
  // native boundary before it (`data-boundary`) and the row the one past its last (`data-end-boundary`).
  const rowOf = (held: Press): HTMLElement | null => held.element.closest<HTMLElement>('[role="tablist"]') ?? strip.current;
  const dropAt = (held: Press): Drop | null => {
    const row = rowOf(held);
    if (!row) return null;
    const box = row.getBoundingClientRect();
    if (held.y < box.top - 12 || held.y > box.bottom + 12 || held.x < box.left - 12 || held.x > box.right + 12) return null;
    const items = [...row.querySelectorAll<HTMLElement>(":scope > .tab-strip-item")];
    const at = tabDropBoundary(items.map((item) => item.getBoundingClientRect()), held.x);
    const item = items[at];
    if (item) return { boundary: Number(item.dataset["boundary"] ?? at), before: item.dataset["dropKey"] ?? null, after: null };
    return { boundary: Number(row.dataset["endBoundary"] ?? current.current.ids.length), before: null, after: items[items.length - 1]?.dataset["dropKey"] ?? null };
  };
  const paintDrag = (held: Press): void => {
    const drop = dropAt(held) ?? { boundary: null, before: null, after: null };
    setDrag((old) => old?.tabId === held.tabId && old.boundary === drop.boundary && old.before === drop.before && old.after === drop.after
      ? old : { tabId: held.tabId, ...drop });
  };
  const tick = (): void => {
    const held = press.current;
    const row = held ? rowOf(held) : null;
    if (!held?.started || !row) { animation.current = null; return; }
    const box = row.getBoundingClientRect();
    const right = row.querySelector<HTMLElement>(".tab-strip-add")?.getBoundingClientRect().left ?? box.right;
    if (held.y >= box.top - 12 && held.y <= box.bottom + 12) {
      const direction = held.x < box.left + 28 ? -1 : held.x > right - 28 ? 1 : 0;
      if (direction) { row.scrollLeft += direction * 8; paintDrag(held); }
    }
    animation.current = requestAnimationFrame(tick);
  };
  const onPointerDown = (event: PointerEvent<HTMLElement>, tabId: string): void => {
    // Touch keeps its native swipe scroll; its menu offers the same adjacent moves.
    if (event.pointerType !== "mouse" || event.button !== 0 || event.ctrlKey || !event.isPrimary) return;
    suppressClick.current = false;
    if (operation.current || current.current.ids.length < 2) return;
    event.preventDefault(); // dragging an inactive tab must not steal terminal or keyboard focus
    const element = event.currentTarget;
    press.current = { tabId, pointerId: event.pointerId, element, x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, started: false };
    element.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>): void => {
    const held = press.current;
    if (!held || event.pointerId !== held.pointerId) return;
    held.x = event.clientX; held.y = event.clientY;
    if (!held.started) {
      if (Math.hypot(held.x - held.startX, held.y - held.startY) < 6) return;
      held.started = true;
      suppressClick.current = true;
      animation.current = requestAnimationFrame(tick);
    }
    paintDrag(held);
  };
  const onPointerUp = (event: PointerEvent<HTMLElement>): void => {
    const held = press.current;
    if (!held || event.pointerId !== held.pointerId) return;
    held.x = event.clientX; held.y = event.clientY;
    const boundary = held.started ? dropAt(held)?.boundary ?? null : null;
    cancelDrag();
    if (boundary !== null) requestMove(held.tabId, boundary);
  };
  useLayoutEffect(() => {
    if (!drag) return;
    const escape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); cancelDrag();
    };
    window.addEventListener("keydown", escape, true);
    window.addEventListener("blur", cancelDrag);
    return () => { window.removeEventListener("keydown", escape, true); window.removeEventListener("blur", cancelDrag); };
  }, [drag?.tabId]);

  return { drag, moving, moveAdjacent, cancelDrag, onPointerDown, onPointerMove, onPointerUp,
    consumeClick: (detail: number): boolean => { const suppress = detail !== 0 && suppressClick.current; suppressClick.current = false; return suppress; } };
}
