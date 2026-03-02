import { useState, useContext, useEffect, ChangeEvent, FormEvent } from "react";
import { useMutation } from "react-query";
import { Link } from "react-router-dom";
import { SignedUser, SignedUserType } from "common";
import { LoginPostResponse } from "server";
import { Notifier, call, Context } from "client";
import LoginIcon from "./components/LoginIcon";
import "./index.scss";

interface LoginBody {
  password: string;
  email?: string;
  username?: string;
}

const Home = () => {
  const { setUserInfo } = useContext(Context);
  const [usernameInput, setUsernameInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");

  const onChangeUsername = (e: ChangeEvent<HTMLInputElement>) => {
    setUsernameInput(e.target.value);
  };

  const onChangePassword = (e: ChangeEvent<HTMLInputElement>) => {
    setPasswordInput(e.target.value);
  };

  const mutation = useMutation((body: LoginBody) => {
    return call.post<LoginPostResponse>("/api/users/login", body);
  });

  let infoMessage;

  if (mutation.isLoading) infoMessage = "🧐 Checking...";
  if (mutation.isError) infoMessage = "🤯 Server error";
  if (mutation.data?.status === "success") infoMessage = "🤗 Welcome!";
  if (mutation.data?.status === "failed") infoMessage = "🤔 Wrong Password";

  useEffect(() => {
    const isSuccess = mutation.data?.status === "success";
    if (isSuccess && setUserInfo) {
      const user = new SignedUser(
        mutation.data?.body as unknown as SignedUserType
      );
      setTimeout(() => setUserInfo(user), 500);
    }
  }, [mutation.data, setUserInfo]);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const body: LoginBody = { password: passwordInput };
    if (usernameInput.includes("@")) body.email = usernameInput;
    else body.username = usernameInput;
    await new Notifier().requestPermission();
    mutation.mutate(body);
  };

  return (
    <div className="container_login">
      <form className="login_card" onSubmit={onSubmit}>
        <h3 className="greeting">Please log in</h3>
        <div className="info_message">{infoMessage}</div>
        <input
          className="login_ui"
          placeholder="username or email"
          type="text"
          name="username"
          autoComplete="username"
          value={usernameInput}
          onChange={onChangeUsername}
        />
        <input
          className="login_ui"
          placeholder="password"
          type="password"
          name="password"
          autoComplete="current-password"
          value={passwordInput}
          onChange={onChangePassword}
        />
        <button className="login_ui" type="submit">
          <LoginIcon />
          <span>Login</span>
        </button>
        <div className="card_footer">
          <div className="info_message">
            <span>Forgot password?</span>
            &nbsp;
            <Link to="/set-info">Reset Password</Link>
          </div>
          <div className="info_message">
            <span>Don't have account?</span>
            &nbsp;
            <Link to="/set-info">Sign Up</Link>
          </div>
        </div>
      </form>
    </div>
  );
};

export default Home;
