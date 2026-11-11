// Route params stay serialisable so record deep links can address them.
export type InventoryRoutes = { Inventory: undefined; Item: { id: string }; EditItem: { id: string }; AdjustStock: { id: string; kind?: "count" | "receipt" } };
export type ProjectRoutes = { Projects: undefined; Project: { id: string }; NewProject: undefined };
export type ServerRoutes = { Workspace: undefined; PendingChanges: undefined };
