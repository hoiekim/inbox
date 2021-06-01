import React, { useState, useContext } from "react";
import { useHistory } from "react-router-dom";
import { useMutation } from "react-query";
import { Context } from "../index";
import "./index.scss";

const domainName = process.env.REACT_APP_DOMAIN || "My Domain";

const Home = () => {
  const { isLogin } = useContext(Context);
  const history = useHistory();

  if (isLogin) history.push("/box");

  const [pwInput, setPwInput] = useState("");

  const onChangePw = (e) => {
    setPwInput(e.target.value);
  };

  const mutation = useMutation((input) => {
    return fetch("/admin", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        password: pwInput
      })
    }).then((r) => r.json());
  });

  let infoMessage;

  if (mutation.isLoading) infoMessage = "🧐 Checking...";
  if (mutation.isError) infoMessage = "🤯 Server error";
  if (mutation.data === true) {
    infoMessage = "🤗 Welcome!";
    setTimeout(() => history.push("/box"), 500);
  }
  if (mutation.data === false) infoMessage = "🤔 Wrong Password";

  const login = () => {
    mutation.mutate(pwInput);
  };

  const onKeyDownInput = (e) => {
    if (e.key === "Enter") login();
  };

  return (
    <>
      <h1>{domainName} Inbox</h1>
      <h3 className="greeting">Please log in</h3>
      <div className="info_message">{infoMessage}</div>
      <div>
        <input
          id="adminPw"
          placeholder="Admin Only"
          type="password"
          value={pwInput}
          onKeyDown={onKeyDownInput}
          onChange={onChangePw}
        />
        <button id="login" onClick={login}>
          Login
        </button>
      </div>
    </>
  );
};

export default Home;
