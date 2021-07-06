import React, { useState, useContext, useEffect } from "react";
import { useMutation } from "react-query";

import LoginIcon from "./components/LoginIcon";

import { Context } from "..";

import "./index.scss";

const Home = () => {
  const { setUserInfo } = useContext(Context);
  const [usernameInput, setUsernameInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");

  const onChangeUsername = (e) => {
    setUsernameInput(e.target.value);
  };

  const onChangePassword = (e) => {
    setPasswordInput(e.target.value);
  };

  const mutation = useMutation((body) => {
    return fetch("/user/sign-in", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    }).then((r) => r.json());
  });

  let infoMessage;

  if (mutation.isLoading) infoMessage = "🧐 Checking...";
  if (mutation.isError) infoMessage = "🤯 Server error";
  if (mutation.data === true) infoMessage = "🤗 Welcome!";
  if (mutation.data === false) infoMessage = "🤔 Wrong Password";

  useEffect(() => {
    if (mutation.data && setUserInfo) {
      setTimeout(() => {
        setUserInfo(true);
      }, 500);
    }
  }, [mutation.data, setUserInfo]);

  const onClickLogin = () => {
    const body = { password: passwordInput };
    if (usernameInput.includes("@")) body.email = usernameInput;
    else body.username = usernameInput;
    mutation.mutate(body);
  };

  const onKeyDownInput = (e) => {
    if (e.key === "Enter") onClickLogin();
  };

  return (
    <div className="container_login">
      <blockquote className="login_card">
        <h3 className="greeting">Please log in</h3>
        <div className="info_message">{infoMessage}</div>
        <input
          className="login_ui"
          placeholder="username or email"
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
        <button className="login_ui" onClick={onClickLogin}>
          <LoginIcon />
          <span>Login</span>
        </button>
      </blockquote>
    </div>
  );
};

export default Home;
