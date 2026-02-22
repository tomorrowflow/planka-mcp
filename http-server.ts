/**
 * HTTP Server wrapper for Planka MCP
 * Provides streamable HTTP transport for MCP protocol
 *
 * This implements the "streamable-http" pattern where:
 * - Client sends POST with JSON-RPC request
 * - Server responds with SSE stream containing the response
 */

import express, { Request, Response } from "express";
import { randomUUID } from "crypto";
import { z } from "zod";

// Import Planka operations
import * as boardMemberships from "./operations/boardMemberships.js";
import * as boards from "./operations/boards.js";
import * as cards from "./operations/cards.js";
import * as comments from "./operations/comments.js";
import * as labels from "./operations/labels.js";
import * as lists from "./operations/lists.js";
import * as projects from "./operations/projects.js";
import * as tasks from "./operations/tasks.js";

// Import custom tools
import {
  createCardWithTasks,
  getBoardSummary,
  getCardDetails,
  getActivityFeed,
  resolveUsers,
} from "./tools/index.js";

import { VERSION } from "./common/version.js";

const PORT = parseInt(process.env.PLANKA_MCP_PORT || "3008", 10);

// Tool definitions
interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const tools: Tool[] = [];

// Helper to register tools
function registerTool(
  name: string,
  description: string,
  inputSchema: object,
  handler: (args: Record<string, unknown>) => Promise<unknown>
) {
  tools.push({ name, description, inputSchema, handler });
}

// Register all tools
function setupTools() {
  // 1. Project and Board Manager
  registerTool(
    "mcp_kanban_project_board_manager",
    "Manage projects and boards with various operations",
    {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["get_projects", "get_project", "get_boards", "create_board", "get_board", "update_board", "delete_board", "get_board_summary"],
          description: "The action to perform"
        },
        id: { type: "string", description: "The ID of the project or board" },
        projectId: { type: "string", description: "The ID of the project" },
        name: { type: "string", description: "The name of the board" },
        position: { type: "number", description: "The position of the board" },
        type: { type: "string", description: "The type of the board" },
        page: { type: "number", description: "The page number for pagination" },
        perPage: { type: "number", description: "The number of items per page" },
        boardId: { type: "string", description: "The ID of the board for summary" },
        includeTaskDetails: { type: "boolean", description: "Include task details" },
        includeComments: { type: "boolean", description: "Include comments" },
      },
      required: ["action"],
    },
    async (args) => {
      switch (args.action) {
        case "get_projects":
          if (!args.page || !args.perPage) throw new Error("page and perPage are required");
          return await projects.getProjects(args.page as number, args.perPage as number);
        case "get_project":
          if (!args.id) throw new Error("id is required");
          return await projects.getProject(args.id as string);
        case "get_boards":
          if (!args.projectId) throw new Error("projectId is required");
          return await boards.getBoards(args.projectId as string);
        case "create_board":
          if (!args.projectId || !args.name || args.position === undefined) throw new Error("projectId, name, and position are required");
          return await boards.createBoard({ projectId: args.projectId as string, name: args.name as string, position: args.position as number });
        case "get_board":
          if (!args.id) throw new Error("id is required");
          return await boards.getBoard(args.id as string);
        case "update_board":
          if (!args.id || !args.name || args.position === undefined) throw new Error("id, name, and position are required");
          return await boards.updateBoard(args.id as string, { name: args.name as string, position: args.position as number, ...(args.type ? { type: args.type as string } : {}) } as any);
        case "delete_board":
          if (!args.id) throw new Error("id is required");
          return await boards.deleteBoard(args.id as string);
        case "get_board_summary":
          if (!args.boardId) throw new Error("boardId is required");
          return await getBoardSummary({ boardId: args.boardId as string, includeTaskDetails: args.includeTaskDetails as boolean, includeComments: args.includeComments as boolean });
        default:
          throw new Error(`Unknown action: ${args.action}`);
      }
    }
  );

  // 2. List Manager
  registerTool(
    "mcp_kanban_list_manager",
    "Manage kanban lists with various operations",
    {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get_all", "create", "update", "delete", "get_one"], description: "The action to perform" },
        id: { type: "string", description: "The ID of the list" },
        boardId: { type: "string", description: "The ID of the board" },
        name: { type: "string", description: "The name of the list" },
        position: { type: "number", description: "The position of the list" },
      },
      required: ["action"],
    },
    async (args) => {
      switch (args.action) {
        case "get_all":
          if (!args.boardId) throw new Error("boardId is required");
          return await lists.getLists(args.boardId as string);
        case "create":
          if (!args.boardId || !args.name || args.position === undefined) throw new Error("boardId, name, and position are required");
          return await lists.createList({ boardId: args.boardId as string, name: args.name as string, position: args.position as number });
        case "get_one":
          if (!args.id) throw new Error("id is required");
          return await lists.getList(args.id as string);
        case "update":
          if (!args.id || !args.name || args.position === undefined) throw new Error("id, name, and position are required");
          return await lists.updateList(args.id as string, { name: args.name as string, position: args.position as number });
        case "delete":
          if (!args.id) throw new Error("id is required");
          return await lists.deleteList(args.id as string);
        default:
          throw new Error(`Unknown action: ${args.action}`);
      }
    }
  );

  // 3. Card Manager
  registerTool(
    "mcp_kanban_card_manager",
    "Manage kanban cards with various operations",
    {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get_all", "create", "get_one", "update", "move", "duplicate", "delete", "create_with_tasks", "get_details"], description: "The action to perform" },
        id: { type: "string" },
        cardId: { type: "string" },
        listId: { type: "string" },
        boardId: { type: "string" },
        projectId: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        position: { type: "number" },
        dueDate: { type: "string" },
        isCompleted: { type: "boolean" },
        type: { type: "string", description: "Card type (e.g., 'project', 'task')" },
        tasks: { type: "array", items: { type: "string" } },
        comment: { type: "string" },
      },
      required: ["action"],
    },
    async (args) => {
      switch (args.action) {
        case "get_all":
          if (!args.listId) throw new Error("listId is required");
          return await cards.getCards(args.listId as string);
        case "create":
          if (!args.listId || !args.name) throw new Error("listId and name are required");
          return await cards.createCard({ listId: args.listId as string, name: args.name as string, description: (args.description as string) || "", position: (args.position as number) || 0, type: args.type as string | undefined });
        case "get_one":
          if (!args.id) throw new Error("id is required");
          return await cards.getCard(args.id as string);
        case "update":
          if (!args.id) throw new Error("id is required");
          const cardOpts: any = {};
          if (args.name !== undefined) cardOpts.name = args.name;
          if (args.description !== undefined) cardOpts.description = args.description;
          if (args.position !== undefined) cardOpts.position = args.position;
          if (args.dueDate !== undefined) cardOpts.dueDate = args.dueDate;
          if (args.isCompleted !== undefined) cardOpts.isCompleted = args.isCompleted;
          return await cards.updateCard(args.id as string, cardOpts);
        case "move":
          if (!args.id || !args.listId || args.position === undefined) throw new Error("id, listId, and position are required");
          return await cards.moveCard(args.id as string, args.listId as string, args.position as number, args.boardId as string | undefined, args.projectId as string | undefined);
        case "duplicate":
          if (!args.id || args.position === undefined) throw new Error("id and position are required");
          return await cards.duplicateCard(args.id as string, args.position as number);
        case "delete":
          if (!args.id) throw new Error("id is required");
          return await cards.deleteCard(args.id as string);
        case "create_with_tasks":
          if (!args.listId || !args.name) throw new Error("listId and name are required");
          return await createCardWithTasks({ listId: args.listId as string, name: args.name as string, description: args.description as string, tasks: args.tasks as string[], comment: args.comment as string, position: args.position as number, type: args.type as string | undefined });
        case "get_details":
          if (!args.cardId) throw new Error("cardId is required");
          return await getCardDetails({ cardId: args.cardId as string });
        default:
          throw new Error(`Unknown action: ${args.action}`);
      }
    }
  );

  // 4. Stopwatch Manager
  registerTool(
    "mcp_kanban_stopwatch",
    "Manage card stopwatches for time tracking",
    {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "stop", "get", "reset"], description: "The action to perform" },
        id: { type: "string", description: "The ID of the card" },
      },
      required: ["action", "id"],
    },
    async (args) => {
      switch (args.action) {
        case "start": return await cards.startCardStopwatch(args.id as string);
        case "stop": return await cards.stopCardStopwatch(args.id as string);
        case "get": return await cards.getCardStopwatch(args.id as string);
        case "reset": return await cards.resetCardStopwatch(args.id as string);
        default: throw new Error(`Unknown action: ${args.action}`);
      }
    }
  );

  // 5. Label Manager
  registerTool(
    "mcp_kanban_label_manager",
    "Manage kanban labels with various operations",
    {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get_all", "create", "update", "delete", "add_to_card", "remove_from_card"] },
        id: { type: "string" },
        boardId: { type: "string" },
        cardId: { type: "string" },
        labelId: { type: "string" },
        name: { type: "string" },
        color: { type: "string" },
        position: { type: "number" },
      },
      required: ["action"],
    },
    async (args) => {
      switch (args.action) {
        case "get_all":
          if (!args.boardId) throw new Error("boardId is required");
          return await labels.getLabels(args.boardId as string);
        case "create":
          if (!args.boardId || !args.name || !args.color || args.position === undefined) throw new Error("boardId, name, color, and position are required");
          return await labels.createLabel({ boardId: args.boardId as string, name: args.name as string, color: args.color as any, position: args.position as number });
        case "update":
          if (!args.id || !args.name || !args.color || args.position === undefined) throw new Error("id, name, color, and position are required");
          return await labels.updateLabel(args.id as string, { name: args.name as string, color: args.color as any, position: args.position as number });
        case "delete":
          if (!args.id) throw new Error("id is required");
          return await labels.deleteLabel(args.id as string);
        case "add_to_card":
          if (!args.cardId || !args.labelId) throw new Error("cardId and labelId are required");
          return await labels.addLabelToCard(args.cardId as string, args.labelId as string);
        case "remove_from_card":
          if (!args.cardId || !args.labelId) throw new Error("cardId and labelId are required");
          return await labels.removeLabelFromCard(args.cardId as string, args.labelId as string);
        default:
          throw new Error(`Unknown action: ${args.action}`);
      }
    }
  );

  // 6. Task Manager
  registerTool(
    "mcp_kanban_task_manager",
    "Manage kanban tasks with various operations",
    {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get_all", "create", "batch_create", "get_one", "update", "delete", "complete_task"] },
        id: { type: "string" },
        cardId: { type: "string" },
        name: { type: "string" },
        isCompleted: { type: "boolean" },
        position: { type: "number" },
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              cardId: { type: "string", description: "The ID of the card for this task" },
              name: { type: "string", description: "The name of this task" },
              position: { type: "number", description: "The position of this task" },
            },
            required: ["cardId", "name"],
          },
        },
      },
      required: ["action"],
    },
    async (args) => {
      switch (args.action) {
        case "get_all":
          if (!args.cardId) throw new Error("cardId is required");
          return await tasks.getTasks(args.cardId as string);
        case "create":
          if (!args.cardId || !args.name) throw new Error("cardId and name are required");
          return await tasks.createTask({ cardId: args.cardId as string, name: args.name as string, position: args.position as number });
        case "batch_create":
          if (!args.tasks || (args.tasks as any[]).length === 0) throw new Error("tasks array is required");
          // If tasks don't have cardId, fall back to top-level cardId
          const batchTasks = (args.tasks as any[]).map((t: any) => ({
            ...t,
            cardId: t.cardId || args.cardId,
          }));
          if (batchTasks.some((t: any) => !t.cardId)) throw new Error("Each task must have a cardId, or provide cardId at the top level");
          return await tasks.batchCreateTasks({ tasks: batchTasks });
        case "get_one":
          if (!args.id) throw new Error("id is required");
          return await tasks.getTask(args.id as string);
        case "update":
          if (!args.id) throw new Error("id is required");
          const taskOpts: any = {};
          if (args.name !== undefined) taskOpts.name = args.name;
          if (args.position !== undefined) taskOpts.position = args.position;
          if (args.isCompleted !== undefined) taskOpts.isCompleted = args.isCompleted;
          return await tasks.updateTask(args.id as string, taskOpts);
        case "complete_task":
          if (!args.id) throw new Error("id is required");
          return await tasks.updateTask(args.id as string, { isCompleted: true } as any);
        case "delete":
          if (!args.id) throw new Error("id is required");
          return await tasks.deleteTask(args.id as string);
        default:
          throw new Error(`Unknown action: ${args.action}`);
      }
    }
  );

  // 7. Comment Manager
  registerTool(
    "mcp_kanban_comment_manager",
    "Manage card comments with various operations",
    {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get_all", "create", "get_one", "update", "delete"] },
        id: { type: "string" },
        cardId: { type: "string" },
        text: { type: "string" },
      },
      required: ["action"],
    },
    async (args) => {
      switch (args.action) {
        case "get_all":
          if (!args.cardId) throw new Error("cardId is required");
          return await comments.getComments(args.cardId as string);
        case "create":
          if (!args.cardId || !args.text) throw new Error("cardId and text are required");
          return await comments.createComment({ cardId: args.cardId as string, text: args.text as string });
        case "get_one":
          if (!args.id) throw new Error("id is required");
          return await comments.getComment(args.id as string);
        case "update":
          if (!args.id || !args.text) throw new Error("id and text are required");
          return await comments.updateComment(args.id as string, { text: args.text as string });
        case "delete":
          if (!args.id) throw new Error("id is required");
          return await comments.deleteComment(args.id as string);
        default:
          throw new Error(`Unknown action: ${args.action}`);
      }
    }
  );

  // 8. Membership Manager
  registerTool(
    "mcp_kanban_membership_manager",
    "Manage board memberships with various operations",
    {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get_all", "create", "get_one", "update", "delete"] },
        id: { type: "string" },
        boardId: { type: "string" },
        userId: { type: "string" },
        role: { type: "string", enum: ["editor", "viewer"] },
        canComment: { type: "boolean" },
      },
      required: ["action"],
    },
    async (args) => {
      switch (args.action) {
        case "get_all":
          if (!args.boardId) throw new Error("boardId is required");
          return await boardMemberships.getBoardMemberships(args.boardId as string);
        case "create":
          if (!args.boardId || !args.userId || !args.role) throw new Error("boardId, userId, and role are required");
          return await boardMemberships.createBoardMembership({ boardId: args.boardId as string, userId: args.userId as string, role: args.role as any });
        case "get_one":
          if (!args.id) throw new Error("id is required");
          return await boardMemberships.getBoardMembership(args.id as string);
        case "update":
          if (!args.id) throw new Error("id is required");
          const memOpts: any = {};
          if (args.role !== undefined) memOpts.role = args.role;
          if (args.canComment !== undefined) memOpts.canComment = args.canComment;
          return await boardMemberships.updateBoardMembership(args.id as string, memOpts);
        case "delete":
          if (!args.id) throw new Error("id is required");
          return await boardMemberships.deleteBoardMembership(args.id as string);
        default:
          throw new Error(`Unknown action: ${args.action}`);
      }
    }
  );

  // 9. Activity Feed - Track changes across a project
  registerTool(
    "mcp_kanban_activity_feed",
    "Get activity feed showing recent changes in a project. Returns new/updated cards, comments, task completions within a time range. Use this to understand what changed without checking each card individually.",
    {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["get_activity", "resolve_users"],
          description: "The action to perform"
        },
        projectId: {
          type: "string",
          description: "The ID of the project to get activity for (required for get_activity)"
        },
        since: {
          type: "string",
          description: "ISO date string - start of time range (defaults to 24h ago)"
        },
        until: {
          type: "string",
          description: "ISO date string - end of time range (defaults to now)"
        },
        maxComments: {
          type: "number",
          description: "Maximum number of comment entries to return (default: 20)"
        },
        userIds: {
          type: "array",
          items: { type: "string" },
          description: "Array of user IDs to resolve (for resolve_users action)"
        },
      },
      required: ["action"],
    },
    async (args) => {
      switch (args.action) {
        case "get_activity":
          if (!args.projectId) throw new Error("projectId is required for get_activity action");
          return await getActivityFeed({
            projectId: args.projectId as string,
            since: args.since as string | undefined,
            until: args.until as string | undefined,
            maxComments: (args.maxComments as number | undefined) ?? 20,
          });
        case "resolve_users":
          if (!args.userIds || (args.userIds as string[]).length === 0) throw new Error("userIds array is required for resolve_users action");
          return await resolveUsers({
            userIds: args.userIds as string[],
          });
        default:
          throw new Error(`Unknown action: ${args.action}`);
      }
    }
  );
}

// Session management
interface Session {
  id: string;
  initialized: boolean;
  createdAt: Date;
}

const sessions = new Map<string, Session>();

// Clean up old sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt.getTime() > 30 * 60 * 1000) { // 30 minutes
      sessions.delete(id);
    }
  }
}, 60 * 1000);

// Handle JSON-RPC request
async function handleJsonRpc(request: any, sessionId: string): Promise<any> {
  const { method, params, id } = request;

  // Get or create session
  let session = sessions.get(sessionId);
  if (!session) {
    session = { id: sessionId, initialized: false, createdAt: new Date() };
    sessions.set(sessionId, session);
  }

  try {
    switch (method) {
      case "initialize":
        session.initialized = true;
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: {
              name: "planka-mcp-server",
              version: VERSION,
            },
          },
        };

      case "notifications/initialized":
        // Notification - no response needed
        return null;

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        };

      case "tools/call":
        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        const tool = tools.find((t) => t.name === toolName);

        if (!tool) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Tool not found: ${toolName}` },
          };
        }

        try {
          const result = await tool.handler(toolArgs);
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify(result) }],
            },
          };
        } catch (error: any) {
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: error.message || String(error) },
          };
        }

      default:
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  } catch (error: any) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: error.message || String(error) },
    };
  }
}

// Setup tools
setupTools();

const app = express();
app.use(express.json());

// Health check endpoint
app.get("/health", (req: Request, res: Response) => {
  res.json({
    success: true,
    status: "healthy",
    service: "planka-mcp",
    version: VERSION,
    tools: tools.length,
    timestamp: new Date().toISOString(),
  });
});

// MCP endpoint - handles both streamable-http style (POST with SSE response)
app.post("/mcp", async (req: Request, res: Response) => {
  // Get or generate session ID
  let sessionId = req.headers["mcp-session-id"] as string;
  if (!sessionId) {
    sessionId = randomUUID();
  }

  const request = req.body;
  console.log(`[${sessionId}] Request: ${request.method}`);

  // Handle the request
  const response = await handleJsonRpc(request, sessionId);

  // Set session ID header
  res.setHeader("Mcp-Session-Id", sessionId);

  // For notifications, just acknowledge
  if (response === null) {
    res.status(202).json({ success: true });
    return;
  }

  // Return as SSE for compatibility with streamable-http clients
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  res.write(`data: ${JSON.stringify(response)}\n\n`);
  res.end();
});

// Also support GET for SSE connection establishment (optional)
app.get("/mcp", (req: Request, res: Response) => {
  const sessionId = randomUUID();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Mcp-Session-Id", sessionId);

  // Send endpoint event
  res.write(`event: endpoint\ndata: /mcp?sessionId=${sessionId}\n\n`);

  // Keep connection alive
  const keepAlive = setInterval(() => {
    res.write(": keepalive\n\n");
  }, 30000);

  req.on("close", () => {
    clearInterval(keepAlive);
    sessions.delete(sessionId);
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Planka MCP HTTP server running on http://0.0.0.0:${PORT}`);
  console.log(`  Health: http://localhost:${PORT}/health`);
  console.log(`  MCP:    http://localhost:${PORT}/mcp`);
  console.log(`  Tools:  ${tools.length} registered`);
});
