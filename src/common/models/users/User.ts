import { WithRequired, getRandomId, DateString } from "common";
import { Model } from "../Model";

export interface UserType {
  id?: string;
  email?: string;
  username?: string;
  password?: string;
  token?: string;
  expiry?: DateString;
}

@Model.prefillable
export class User extends Model<User> implements UserType {
  id?: string;
  email?: string;
  username?: string;
  password?: string;
  token?: string;
  expiry?: DateString;

  mask = () => {
    const { id, email, username, token, expiry } = this;
    return new MaskedUser({ id, email, username, token, expiry });
  };

  getSigned = () => {
    const { id, username, email, password } = this;
    if (!id || !username || !password || !email) return undefined;
    return new SignedUser(this.mask() as SignedUser);
  };
}

export type MaskedUserType = Omit<UserType, "password">;

@Model.prefillable
export class MaskedUser extends Model<MaskedUser> implements MaskedUserType {
  id?: string;
  email?: string;
  username?: string;
  token?: string;
  expiry?: string;
}

export type SignedUserType = WithRequired<
  MaskedUserType,
  "id" | "email" | "username"
>;

@Model.prefillable
export class SignedUser extends Model<SignedUser> implements SignedUserType {
  id = getRandomId();
  email = "unknown";
  username = "unknown";
  token?: string;
  expiry?: string;
}
