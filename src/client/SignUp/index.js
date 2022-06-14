import React, { useState, useContext, useEffect } from "react";
import { useMutation } from "react-query";
import { useParams, useLocation, Link } from "react-router-dom";

import SignUpIcon from "./components/SignUpIcon";
import UserEditIcon from "./components/UserEditIcon";

import { Context } from "..";

import "./index.scss";

const SignUp = () => {
  const { setUserInfo } = useContext(Context);

  const { email } = useParams();
  const query = new URLSearchParams(useLocation().search);
  const token = query.get("t");
  const username = query.get("u");

  const [emailInput, setEmailInput] = useState(email || "");
  const [usernameInput, setUsernameInput] = useState(username || "");
  const [passwordInput, setPasswordInput] = useState("");
  const [passwordConfirmInput, setPasswordConfirmInput] = useState("");

  const onChangeEmail = (e) => {
    setEmailInput(e.target.value);
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
    if (email) url = "/user/set-info";
    else url = "/user/send-token";
    return fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    }).then((r) => r.json());
  });

  let infoMessage;

  if (email) {
    infoMessage = "🤐 Please set your user information.";
    if (mutation.isLoading) infoMessage = "🧐 Setting your information...";
    if (mutation.isError) infoMessage = "🤯 Server error";
    if (mutation.data?.username) infoMessage = "🤗 All set up!";
    if (mutation.data === false) {
      infoMessage = "🤔 Something is wrong. Please try again.";
    }
  } else {
    infoMessage = "😀 Please provide your email.";
    if (mutation.isLoading) infoMessage = "🧐 Sending confirmation email...";
    if (mutation.isError) infoMessage = "🤯 Server error";
    if (mutation.data === true) {
      infoMessage =
        "🤗 Please check your mail box and continue to set your user information.";
    }
    if (mutation.data === false)
      infoMessage = "🤔 Something is wrong. Please try again.";
  }

  useEffect(() => {
    if (mutation.data?.username && setUserInfo) {
      setTimeout(() => {
        setUserInfo(mutation.data);
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
