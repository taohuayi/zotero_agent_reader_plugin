export const STREAMING_BOTTOM_THRESHOLD_PX = 2;

export interface ScrollViewport {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** Put a newly-started stream at the bottom so later updates can follow it. */
export function scrollToBottom(viewport: ScrollViewport): void {
  viewport.scrollTop = viewport.scrollHeight;
}

/** Return whether a viewport is close enough to the bottom to keep following. */
export function isAtScrollBottom(
  viewport: ScrollViewport,
  threshold = STREAMING_BOTTOM_THRESHOLD_PX,
): boolean {
  const maxScrollTop = Math.max(
    0,
    viewport.scrollHeight - viewport.clientHeight,
  );
  const scrollTop = Math.max(0, viewport.scrollTop);
  return maxScrollTop - scrollTop <= Math.max(0, threshold);
}

/**
 * Apply a streaming DOM update without stealing the reader's scroll position.
 * Following resumes naturally once the reader scrolls back to the bottom.
 */
export function preserveStreamingScroll<T>(
  viewport: ScrollViewport,
  update: () => T,
  threshold = STREAMING_BOTTOM_THRESHOLD_PX,
): T {
  const shouldFollow = isAtScrollBottom(viewport, threshold);
  const previousScrollTop = viewport.scrollTop;

  try {
    return update();
  } finally {
    if (shouldFollow) scrollToBottom(viewport);
    else viewport.scrollTop = previousScrollTop;
  }
}
