import { z } from "zod/v3";

type Schema = z.ZodTypeAny;
type Def = Record<string, unknown> & { typeName?: string };

/**
 * Return a read-side copy of a shared contract schema that strips unknown
 * object keys at every depth instead of rejecting them. A newer server can then
 * add response fields without breaking this installed app. Refinements,
 * transforms, enums and required fields are retained, so canonical invariants
 * (for example availableQuantity <= quantity) and missing data still fail.
 * Request bodies keep the strict contract schemas.
 */
export function tolerant<T extends Schema>(schema: T): T {
  return convert(schema) as T;
}

function convert(schema: Schema): Schema {
  const def = (schema as unknown as { _def: Def })._def;
  switch (def.typeName) {
    case "ZodObject": {
      const shape = (schema as z.AnyZodObject).shape as Record<string, Schema>;
      const next = Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, convert(value)]));
      return new z.ZodObject({ ...(def as unknown as z.ZodObjectDef), shape: () => next, unknownKeys: "strip" });
    }
    case "ZodArray": return new z.ZodArray({ ...(def as unknown as z.ZodArrayDef), type: convert(def.type as Schema) });
    case "ZodOptional": return new z.ZodOptional({ ...(def as unknown as z.ZodOptionalDef), innerType: convert(def.innerType as Schema) });
    case "ZodNullable": return new z.ZodNullable({ ...(def as unknown as z.ZodNullableDef), innerType: convert(def.innerType as Schema) });
    case "ZodDefault": return new z.ZodDefault({ ...(def as unknown as z.ZodDefaultDef), innerType: convert(def.innerType as Schema) });
    case "ZodCatch": return new z.ZodCatch({ ...(def as unknown as z.ZodCatchDef), innerType: convert(def.innerType as Schema) });
    case "ZodEffects": return new z.ZodEffects({ ...(def as unknown as z.ZodEffectsDef), schema: convert(def.schema as Schema) });
    case "ZodPipeline": return new z.ZodPipeline({ ...(def as unknown as z.ZodPipelineDef<Schema, Schema>), in: convert(def.in as Schema), out: convert(def.out as Schema) });
    case "ZodLazy": { const getter = def.getter as () => Schema; return new z.ZodLazy({ ...(def as unknown as z.ZodLazyDef), getter: () => convert(getter()) }); }
    case "ZodRecord": return new z.ZodRecord({ ...(def as unknown as z.ZodRecordDef), valueType: convert(def.valueType as Schema) });
    case "ZodIntersection": return new z.ZodIntersection({ ...(def as unknown as z.ZodIntersectionDef), left: convert(def.left as Schema), right: convert(def.right as Schema) });
    case "ZodTuple": return new z.ZodTuple({ ...(def as unknown as z.ZodTupleDef), items: (def.items as Schema[]).map(convert) as [Schema, ...Schema[]] });
    case "ZodUnion": return new z.ZodUnion({ ...(def as unknown as z.ZodUnionDef), options: (def.options as Schema[]).map(convert) as [Schema, Schema, ...Schema[]] });
    case "ZodDiscriminatedUnion": {
      const options = (def.options as z.AnyZodObject[]).map((option) => convert(option) as z.AnyZodObject);
      return z.discriminatedUnion(def.discriminator as string, options as [z.AnyZodObject, ...z.AnyZodObject[]]);
    }
    default: return schema;
  }
}
