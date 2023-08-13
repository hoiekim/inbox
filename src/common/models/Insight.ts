import { Model } from "./Model";

@Model.prefillable
export class Insight extends Model<Insight> {
  summary: string[] = [];
  action_items: string[] = [];
  suggested_reply = "";
}
