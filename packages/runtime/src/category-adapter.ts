import type {
  CreateInventoryCategory,
  InventoryCategory,
  UpdateInventoryCategory,
} from "@benchledger/api-contract";
import type {
  InventoryCategoryListOptions,
  InventoryCategoryPort,
  Page,
  RequestContext,
} from "@benchledger/application";
import { InventoryCategoryRepository } from "@benchledger/database";
import type { BenchDatabase } from "@benchledger/database";
import { attempt, clone } from "./utils.js";

/** Durable adapter for the shared user-managed inventory taxonomy. */
export class ProductionInventoryCategoryAdapter implements InventoryCategoryPort {
  public readonly repository: InventoryCategoryRepository;

  public constructor(
    database: BenchDatabase,
    private readonly unitOfWork: { readonly exclusive: <T>(operation: () => T | PromiseLike<T>) => Promise<T> },
    repository?: InventoryCategoryRepository,
  ) {
    this.repository = repository ?? new InventoryCategoryRepository(database);
  }

  listCategories(options: InventoryCategoryListOptions): Promise<Page<InventoryCategory>> {
    return this.unitOfWork.exclusive(() => attempt(() => {
      const result = this.repository.list({
        limit: options.limit,
        includeArchived: options.includeArchived,
        ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      });
      return { data: result.data.map(clone), limit: result.limit, total: result.total, ...(result.nextCursor === undefined ? {} : { nextCursor: result.nextCursor }) };
    }));
  }

  getCategory(id: string): Promise<InventoryCategory | null> {
    return this.unitOfWork.exclusive(() => attempt(() => clone(this.repository.get(id) ?? null)));
  }

  createCategory(input: CreateInventoryCategory, _ctx: RequestContext): Promise<InventoryCategory> {
    return this.unitOfWork.exclusive(() => attempt(() => clone(this.repository.create({
      name: input.name,
      ...(input.id === undefined ? {} : { id: input.id }),
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
    }))));
  }

  updateCategory(id: string, input: UpdateInventoryCategory, expectedVersion: number, _ctx: RequestContext): Promise<InventoryCategory> {
    return this.unitOfWork.exclusive(() => attempt(() => clone(this.repository.update(id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
    }, expectedVersion))));
  }

  archiveCategory(id: string, expectedVersion: number, _ctx: RequestContext): Promise<InventoryCategory> {
    return this.unitOfWork.exclusive(() => attempt(() => clone(this.repository.archive(id, expectedVersion))));
  }

  getItemCategoryNode(itemId: string): Promise<string | null> {
    return this.unitOfWork.exclusive(() => attempt(() => this.repository.getItemCategoryNode(itemId) ?? null));
  }

  assignItemCategory(itemId: string, categoryNodeId: string | null): Promise<void> {
    return this.unitOfWork.exclusive(() => attempt(() => { this.repository.setItemCategoryNode(itemId, categoryNodeId === null ? undefined : categoryNodeId); }));
  }
}
