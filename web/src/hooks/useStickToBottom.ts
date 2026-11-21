import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

const FOLLOW_THRESHOLD = 48;
const BUTTON_THRESHOLD = 160;

/**
 * Keeps a scroll container pinned to the bottom while its content grows, but only while the
 * user is already near the bottom. Any upward scroll by the user stops following at once;
 * returning to the bottom resumes it. Content shrinking (a section collapsing) clamps the
 * scroll position without counting as the user scrolling up.
 */
export function useStickToBottom(
  scrollRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  resetKey: string,
) {
  const following = useRef(true);
  const lastTop = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const [isFollowing, setIsFollowing] = useState(true);

  const setFollowing = useCallback((value: boolean) => {
    if (following.current === value) return;
    following.current = value;
    setIsFollowing(value);
  }, []);

  const distance = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight;

  const pin = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  }, [scrollRef]);

  const scrollToBottom = useCallback(
    (smooth: boolean) => {
      const el = scrollRef.current;
      if (!el) return;
      setFollowing(true);
      setShowJump(false);
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduce ? 'smooth' : 'auto' });
    },
    [scrollRef, setFollowing],
  );

  useLayoutEffect(() => {
    setFollowing(true);
    pin();
    setShowJump(false);
  }, [resetKey, pin, setFollowing]);

  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;

    const onScroll = () => {
      const d = distance(el);
      const top = el.scrollTop;
      if (top < lastTop.current - 1 && d > 2) setFollowing(false);
      else if (d <= FOLLOW_THRESHOLD) setFollowing(true);
      lastTop.current = top;
      setShowJump(d > BUTTON_THRESHOLD);
    };
    // Only a scroll that can actually move the view counts as leaving the bottom.
    const stopFollowing = () => {
      if (el.scrollTop > 0) setFollowing(false);
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) stopFollowing();
    };
    let touchY: number | null = null;
    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0]?.clientY ?? null;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      if (touchY !== null && y !== undefined && y > touchY + 4) stopFollowing();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (['PageUp', 'ArrowUp', 'Home'].includes(e.key)) stopFollowing();
    };
    const observer = new ResizeObserver(() => {
      if (!following.current && el.scrollHeight <= el.clientHeight + 1) setFollowing(true);
      if (following.current) pin();
      setShowJump(distance(el) > BUTTON_THRESHOLD);
    });
    observer.observe(content);
    // The viewport also shrinks when the composer grows or the window is resized.
    observer.observe(el);
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('keydown', onKeyDown);
    return () => {
      observer.disconnect();
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('keydown', onKeyDown);
    };
  }, [scrollRef, contentRef, pin, setFollowing]);

  return { showJump, scrollToBottom, following: isFollowing };
}
