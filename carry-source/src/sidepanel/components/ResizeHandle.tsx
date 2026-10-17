import React, { useRef } from 'react';

interface Props {
  label: string;
  /** Called on press; returns the size (px) being resized at drag start. */
  onDragStart: () => number;
  /** Called while dragging with the start size, the pointer's start Y and current Y. */
  onDrag: (startSize: number, startY: number, currentY: number) => void;
  onDragEnd: () => void;
  /** Double-click restores the default size. */
  onReset: () => void;
}

/** A horizontal bar the user drags up/down (mouse, pen or touch) to resize the areas around it. */
export default function ResizeHandle({ label, onDragStart, onDrag, onDragEnd, onReset }: Props) {
  const dragRef = useRef<{ pointerId: number; startY: number; startSize: number } | null>(null);

  const finish = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    document.body.style.removeProperty('user-select');
    document.body.style.removeProperty('cursor');
    onDragEnd();
  };

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      title={label}
      tabIndex={-1}
      className="group relative z-10 flex h-2.5 flex-none cursor-row-resize touch-none items-center justify-center bg-slate-100 hover:bg-sky-100"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startSize: onDragStart() };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'row-resize';
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        onDrag(drag.startSize, drag.startY, event.clientY);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onDoubleClick={onReset}
    >
      <span className="h-1 w-10 rounded-full bg-slate-300 group-hover:bg-sky-400" aria-hidden="true" />
    </div>
  );
}
