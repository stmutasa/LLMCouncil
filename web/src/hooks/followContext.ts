import { createContext, useContext } from 'react';

/**
 * Whether the thread is following new content at the bottom. When the user has scrolled up to
 * read, automatic expand/collapse is suspended so the text they are reading does not move away.
 */
export const FollowContext = createContext(true);

export function useFollowing(): boolean {
  return useContext(FollowContext);
}
