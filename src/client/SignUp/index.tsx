import { useState, useContext, useEffect } from "react";
import { useMutation } from "react-query";
import { useParams, useLocation, Link } from "react-router-dom";

import SignUpIcon from "./components/SignUpIcon";
import UserEditIcon from "./components/UserEditIcon";

import { Context, call } from "client";

import "./index.scss";
import { MaskedUser, SetInfoPostResponse } from "server";

const SignUp = () => {
  const { setUserInfo } = useContext(Context);

  const { email } = useParams() as any;
  const query = new URLSearchParams(useLocation().search);
  const token = query.get("t");
  const username = query.get("u");

  const [emailInput, setEmailInput] = useState(email || "");
  const [usernameInput, setUsernameInput] = useState(username || "");
  const [passwordInput, setPasswordInput] = useState("");
  const [passwordConfirmInput, setPasswordConfirmInput] = useState("");

  const onChangeEmail = (e: any) => {
    setEmailInput(e.target.value);
  };

  const onChangeUsername = (e: any) => {
    setUsernameInput(e.target.value);
  };

  const onChangePassword = (e: any) => {
    setPasswordInput(e.target.value);
  };

  const onChangePasswordConfirm = (e: any) => {
    setPasswordConfirmInput(e.target.value);
  };

  const mutation = useMutation((body: any) => {
    if (email)
      return call.post<SetInfoPostResponse>("/api/users/set-info", body);
    else return call.post("/api/users/token", body);
  });

  let infoMessage;

  if (email) {
    infoMessage = "🤐 Please set your user information.";
    if (mutation.isLoading) infoMessage = "🧐 Setting your information...";
    if (mutation.isError) infoMessage = "🤯 Server error";
    if (mutation.data?.status === "success") infoMessage = "🤗 All set up!";
    if (mutation.data?.status !== "success") {
      infoMessage = "🤔 Something is wrong. Please try again.";
    }
  } else {
    infoMessage = "😀 Please provide your email.";
    if (mutation.isLoading) infoMessage = "🧐 Sending confirmation email...";
    if (mutation.isError) infoMessage = "🤯 Server error";
    if (mutation.data?.status === "success") {
      infoMessage =
        "🤗 Please check your mail box and continue to set your user information.";
    }
    if (mutation.data?.status !== "success")
      infoMessage = "🤔 Something is wrong. Please try again.";
  }

  useEffect(() => {
    if ((mutation.data as any)?.username && setUserInfo) {
      setTimeout(() => {
        setUserInfo(mutation.data as unknown as MaskedUser);
      }, 500);
    }
  }, [mutation.data, setUserInfo]);

  const onClickSignUp = () => {
    mutation.mutate({
      email: emailInput,
      token,
      username: usernameInput,
      password: passwordInput
    });
    if (email) window.name = "inbox-confirm";
  };

  const onKeyDownInput = (e: any) => {
    if (e.key === "Enter") onClickSignUp();
  };

  return (
    <div className="container_login">
      <blockquote className="login_card">
        <h3 className="greeting">Welcome to Inbox!</h3>
        <div className="info_message">{infoMessage}</div>
        <input
          className="login_ui"
          placeholder="Email address"
          type="email"
          value={emailInput}
          onKeyDown={onKeyDownInput}
          onChange={onChangeEmail}
          disabled={!!email}
        />
        {email ? (
          <>
            <input
              className="login_ui"
              placeholder="username"
              type="username"
              value={usernameInput}
              onKeyDown={onKeyDownInput}
              onChange={onChangeUsername}
              disabled={!!username}
            />
            <input
              className="login_ui"
              placeholder="password"
              type="password"
              value={passwordInput}
              onKeyDown={onKeyDownInput}
              onChange={onChangePassword}
            />
            {passwordInput ? (
              <input
                className="login_ui"
                placeholder="password to confirm"
                type="password"
                value={passwordConfirmInput}
                onKeyDown={onKeyDownInput}
                onChange={onChangePasswordConfirm}
              />
            ) : null}
          </>
        ) : null}
        <button className="login_ui" onClick={onClickSignUp}>
          {email ? (
            <>
              <UserEditIcon />
              <span>Set Up</span>
            </>
          ) : (
            <>
              <SignUpIcon />
              <span>Send Confirm Email</span>
            </>
          )}
        </button>
        <div className="card_footer">
          <div className="info_message">
            <span>Already have an account?</span>
            &nbsp;
            <Link to="/sign-in">Sign In</Link>
          </div>
        </div>
      </blockquote>
    </div>
  );
};

export default SignUp;
