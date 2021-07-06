import React, { useState, useContext, useEffect } from "react";
import { useMutation } from "react-query";
import { useParams, useLocation } from "react-router-dom";

import SignUpIcon from "./components/SignUpIcon";
import UserEditIcon from "./components/UserEditIcon";

import { Context } from "..";

import "./index.scss";

const SignUp = () => {
  const { setUserInfo } = useContext(Context);

  const { id } = useParams();
  const query = new URLSearchParams(useLocation().search);
  const token = query.get("t");

  const [emailInput, setEmailInput] = useState(id ? "***@**.*" : "");
  const [usernameInput, setUsernameInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [passwordConfirmInput, setPasswordConfirmInput] = useState("");

  const onChangeEmail = (e) => {
    if (!id) setEmailInput(e.target.value);
  };

  const onChangeUsername = (e) => {
    setUsernameInput(e.target.value);
  };

  const onChangePassword = (e) => {
    setPasswordInput(e.target.value);
  };

  const onChangePasswordConfirm = (e) => {
    setPasswordConfirmInput(e.target.value);
  };

  const mutation = useMutation((body) => {
    let url;
    if (id) url = "/user/set-info";
    else url = "/user/sign-up";
    return fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    }).then((r) => r.json());
  });

  let infoMessage;

  if (id) infoMessage = "🤐 Please set your username and password.";
  else infoMessage = "😀 Please provide your email to sign up.";

  if (mutation.isLoading) infoMessage = "🧐 Checking...";
  if (mutation.isError) infoMessage = "🤯 Server error";
  if (mutation.data === true) {
    infoMessage = "🤗 Please check your mail box and complete signing up.";
  }
  if (mutation.data === false) infoMessage = "🤔 Please try again.";

  useEffect(() => {
    if (mutation.data && setUserInfo) {
      setTimeout(() => {
        // setUserInfo(true);
      }, 500);
    }
  }, [mutation.data, setUserInfo]);

  const onClickSignUp = () => {
    mutation.mutate({
      email: emailInput,
      id,
      token,
      username: usernameInput,
      password: passwordInput
    });
    window.name = "inbox-confirm";
  };

  const onKeyDownInput = (e) => {
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
          disabled={!!id}
        />
        {id ? (
          <>
            <input
              className="login_ui"
              placeholder="username"
              type="username"
              value={usernameInput}
              onKeyDown={onKeyDownInput}
              onChange={onChangeUsername}
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
          {id ? (
            <>
              <UserEditIcon />
              <span>Set Up</span>
            </>
          ) : (
            <>
              <SignUpIcon />
              <span>Sign Up</span>
            </>
          )}
        </button>
      </blockquote>
    </div>
  );
};

export default SignUp;
