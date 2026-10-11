/**
 * Application statuses the user is following a job in (interested … offer): the "following" quick view of Today and, with the
 * starred jobs, the jobs whose posting the maintenance step rechecks. Pure constant: the client and the server share it.
 */
export const FOLLOWING_STATUSES = ["interested", "preparing", "applied", "interviewing", "offer"] as const;
export type FollowingStatus = (typeof FOLLOWING_STATUSES)[number];
