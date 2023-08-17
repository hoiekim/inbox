import { Model } from "../Model";
import { BadgeCount, Username } from "../miscellaneous";

export class Notifications extends Model.mixin(Map<Username, BadgeCount>) {}
