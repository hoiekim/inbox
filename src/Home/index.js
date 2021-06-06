import React, { useState, useContext, useEffect } from "react";
import { useMutation } from "react-query";

import LoginIcon from "./components/LoginIcon";

import { Context } from "..";

import "./index.scss";

const Home = () => {
  const { setIsLogin } = useContext(Context);
  const [pwInput, setPwInput] = useState("");

  const onChangePw = (e) => {
    setPwInput(e.target.value);
  };

  const login = (input) => {
    return fetch("/admin", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        password: input
      })
    }).then((r) => r.json());
  };

  const mutation = useMutation(login);

  let infoMessage;

  if (mutation.isLoading) infoMessage = "🧐 Checking...";
  if (mutation.isError) infoMessage = "🤯 Server error";
  if (mutation.data === true) infoMessage = "🤗 Welcome!";
  if (mutation.data === false) infoMessage = "🤔 Wrong Password";

  useEffect(() => {
    if (mutation.data && setIsLogin) {
      setTimeout(() => {
        setIsLogin(true);
      }, 500);
    }
  }, [mutation.data, setIsLogin]);

  const onClickLogin = () => {
    mutation.mutate(pwInput);
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
          placeholder="Admin Only"
          type="password"
          value={pwInput}
          onKeyDown={onKeyDownInput}
          onChange={onChangePw}
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
