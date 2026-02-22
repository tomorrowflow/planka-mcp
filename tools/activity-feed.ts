import { z } from "zod";
import { plankaRequest } from "../common/utils.js";
import { getBoards } from "../operations/boards.js";
import { getLists } from "../operations/lists.js";
import { getCards } from "../operations/cards.js";
import { getTasks } from "../operations/tasks.js";
import { getComments } from "../operations/comments.js";

/**
 * Schema for activity feed parameters
 */
export const getActivityFeedSchema = z.object({
    projectId: z.string().describe("The ID of the project to get activity for"),
    since: z.string().optional().describe("ISO date string - start of time range (defaults to 24h ago)"),
    until: z.string().optional().describe("ISO date string - end of time range (defaults to now)"),
    maxComments: z.number().optional().default(20).describe("Maximum number of comment entries to return"),
});

export type GetActivityFeedParams = z.infer<typeof getActivityFeedSchema>;

/**
 * Schema for resolving user IDs to names
 */
export const resolveUsersSchema = z.object({
    userIds: z.array(z.string()).describe("Array of user IDs to resolve"),
});

export type ResolveUsersParams = z.infer<typeof resolveUsersSchema>;

interface ActivityEntry {
    timestamp: string;
    type: "card_created" | "card_updated" | "card_completed" | "comment_added" | "task_created" | "task_completed";
    boardId: string;
    listId?: string;
    cardId: string;
    taskId?: string;
    commentId?: string;
    userId?: string;
    preview?: string;
}

interface ActivityFeedResult {
    query: {
        projectId: string;
        from: string;
        to: string;
    };
    summary: {
        totalChanges: number;
        newCards: number;
        updatedCards: number;
        completedCards: number;
        newComments: number;
        newTasks: number;
        completedTasks: number;
    };
    changes: ActivityEntry[];
    affectedCards: Array<{
        cardId: string;
        cardName: string;
        boardId: string;
        listId: string;
    }>;
    userIds: string[];
}

/**
 * Truncates text to specified length with ellipsis
 */
function truncateText(text: string, maxLength: number = 100): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength - 3) + "...";
}

/**
 * Checks if a date string falls within the specified range
 */
function isWithinRange(dateStr: string | null | undefined, from: Date, to: Date): boolean {
    if (!dateStr) return false;
    const date = new Date(dateStr);
    return date >= from && date <= to;
}

/**
 * Retrieves activity feed for a project within a time range
 */
export async function getActivityFeed(params: GetActivityFeedParams): Promise<ActivityFeedResult> {
    const { projectId, maxComments = 20 } = params;

    // Set default time range (24h ago to now)
    const now = new Date();
    const defaultFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const from = params.since ? new Date(params.since) : defaultFrom;
    const to = params.until ? new Date(params.until) : now;

    const changes: ActivityEntry[] = [];
    const affectedCardsMap = new Map<string, { cardId: string; cardName: string; boardId: string; listId: string }>();
    const userIdsSet = new Set<string>();

    // Counters for summary
    let newCards = 0;
    let updatedCards = 0;
    let completedCards = 0;
    let newComments = 0;
    let newTasks = 0;
    let completedTasks = 0;

    try {
        // Get all boards in the project
        const boards = await getBoards(projectId);

        // Process each board
        for (const board of boards) {
            const boardId = board.id;

            // Get all lists in the board
            const lists = await getLists(boardId);

            // Get all cards for each list
            for (const list of lists) {
                const listId = list.id;
                const cards = await getCards(listId);

                for (const card of cards as any[]) {
                    const cardId = card.id;
                    const cardName = card.name;
                    const createdAt = card.createdAt;
                    const updatedAt = card.updatedAt;
                    const isCompleted = card.isCompleted;

                    let cardHasChanges = false;

                    // Check if card was created within range
                    if (isWithinRange(createdAt, from, to)) {
                        changes.push({
                            timestamp: createdAt,
                            type: "card_created",
                            boardId,
                            listId,
                            cardId,
                        });
                        newCards++;
                        cardHasChanges = true;
                    }
                    // Check if card was updated (but not just created)
                    else if (isWithinRange(updatedAt, from, to)) {
                        // Check if it was marked as completed
                        if (isCompleted && updatedAt) {
                            changes.push({
                                timestamp: updatedAt,
                                type: "card_completed",
                                boardId,
                                listId,
                                cardId,
                            });
                            completedCards++;
                        } else {
                            changes.push({
                                timestamp: updatedAt,
                                type: "card_updated",
                                boardId,
                                listId,
                                cardId,
                            });
                            updatedCards++;
                        }
                        cardHasChanges = true;
                    }

                    // Get tasks for the card to check for task changes
                    try {
                        const tasks = await getTasks(cardId);
                        for (const task of tasks as any[]) {
                            if (isWithinRange(task.createdAt, from, to)) {
                                changes.push({
                                    timestamp: task.createdAt,
                                    type: "task_created",
                                    boardId,
                                    listId,
                                    cardId,
                                    taskId: task.id,
                                });
                                newTasks++;
                                cardHasChanges = true;
                            } else if (task.isCompleted && isWithinRange(task.updatedAt, from, to)) {
                                changes.push({
                                    timestamp: task.updatedAt,
                                    type: "task_completed",
                                    boardId,
                                    listId,
                                    cardId,
                                    taskId: task.id,
                                });
                                completedTasks++;
                                cardHasChanges = true;
                            }
                        }
                    } catch {
                        // Ignore task fetch errors
                    }

                    // Get comments for the card
                    try {
                        const comments = await getComments(cardId);
                        for (const comment of comments as any[]) {
                            if (isWithinRange(comment.createdAt, from, to)) {
                                if (newComments < maxComments) {
                                    changes.push({
                                        timestamp: comment.createdAt,
                                        type: "comment_added",
                                        boardId,
                                        listId,
                                        cardId,
                                        commentId: comment.id,
                                        userId: comment.userId,
                                        preview: truncateText(comment.text || comment.data?.text || "", 100),
                                    });
                                }
                                if (comment.userId) {
                                    userIdsSet.add(comment.userId);
                                }
                                newComments++;
                                cardHasChanges = true;
                            }
                        }
                    } catch {
                        // Ignore comment fetch errors
                    }

                    // Track affected card if it had any changes
                    if (cardHasChanges) {
                        affectedCardsMap.set(cardId, {
                            cardId,
                            cardName,
                            boardId,
                            listId,
                        });
                    }
                }
            }
        }

        // Sort changes by timestamp (most recent first)
        changes.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        return {
            query: {
                projectId,
                from: from.toISOString(),
                to: to.toISOString(),
            },
            summary: {
                totalChanges: changes.length,
                newCards,
                updatedCards,
                completedCards,
                newComments,
                newTasks,
                completedTasks,
            },
            changes,
            affectedCards: Array.from(affectedCardsMap.values()),
            userIds: Array.from(userIdsSet),
        };
    } catch (error) {
        throw new Error(
            `Failed to get activity feed: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

/**
 * Resolves user IDs to user information
 */
export async function resolveUsers(params: ResolveUsersParams): Promise<Record<string, { id: string; name: string | null; username: string; email: string }>> {
    const { userIds } = params;
    const result: Record<string, { id: string; name: string | null; username: string; email: string }> = {};

    try {
        // Get all users from the API
        const response = await plankaRequest("/api/users") as { items?: any[] };

        if (response?.items && Array.isArray(response.items)) {
            const users = response.items;

            for (const userId of userIds) {
                const user = users.find((u: any) => u.id === userId);
                if (user) {
                    result[userId] = {
                        id: user.id,
                        name: user.name,
                        username: user.username,
                        email: user.email,
                    };
                }
            }
        }

        return result;
    } catch (error) {
        throw new Error(
            `Failed to resolve users: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}
