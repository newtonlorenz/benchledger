import { reservationSchema, reconciliationDraftSchema, createReservationSchema } from "@benchledger/api-contract";
import type { CreateReservation, Reservation } from "@benchledger/api-contract";
import { ApiError, workflowRequest, releaseStockReservationRequest } from "./api";

export async function readStockReservations(revisionId: string): Promise<{ reservations: Reservation[]; closed: boolean }> {
  const path = `/project-revisions/${encodeURIComponent(revisionId)}`;
  const [reservations, review] = await Promise.all([workflowRequest<unknown>(`${path}/reservations`), workflowRequest<unknown>(`${path}/reconciliation`)]);
  const parsed = reservationSchema.array().safeParse(reservations);
  const closeout = reconciliationDraftSchema.nullable().safeParse(review);
  if (!parsed.success || !closeout.success) throw new ApiError("Stock set aside could not be verified. Refresh before changing it.", { kind: "server", status: 502 });
  return { reservations: parsed.data, closed: closeout.data?.status === "committed" };
}

function confirmedReservation(payload: unknown): Reservation {
  const data = payload && typeof payload === "object" && "data" in payload ? payload.data : undefined;
  const parsed = reservationSchema.safeParse(data);
  if (!parsed.success) throw new ApiError("The service did not confirm the stock change. Retry unchanged.", { kind: "server", status: 502 });
  return parsed.data;
}

export async function setAsideStock(revisionId: string, input: CreateReservation, key: string): Promise<Reservation> {
  const body = createReservationSchema.parse(input);
  const value = confirmedReservation(await workflowRequest(`/project-revisions/${encodeURIComponent(revisionId)}/reservations`, "POST", body, key));
  if (value.lineId !== body.lineId || value.itemId !== body.itemId || value.quantity !== body.quantity || value.status !== "active") throw new ApiError("The service did not confirm the reviewed reservation. Retry unchanged.", { kind: "server", status: 502 });
  return value;
}

export async function releaseSetAsideStock(reservation: Reservation, key: string): Promise<Reservation> {
  const value = confirmedReservation(await releaseStockReservationRequest(reservation.id, reservation.version, key));
  if (value.id !== reservation.id || value.version !== reservation.version + 1 || value.status !== "released" || value.itemId !== reservation.itemId || value.lineId !== reservation.lineId || value.quantity !== reservation.quantity) throw new ApiError("The service did not confirm the reviewed release. Retry unchanged.", { kind: "server", status: 502 });
  return value;
}
