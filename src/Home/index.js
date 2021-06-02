import React, { useState, useContext, useEffect } from "react";
import { useHistory } from "react-router-dom";
import { useMutation } from "react-query";
import { Context } from "..";
import LoginIcon from "./components/LoginIcon";
import "./index.scss";

const Home = () => {
  const history = useHistory();
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
    if (mutation.data && history && setIsLogin) {
      setTimeout(() => {
        history.push("/box");
        setIsLogin(mutation.data);
      }, 500);
    }
  }, [mutation.data, history, setIsLogin]);

  const onClickLogin = () => {
    mutation.mutate(pwInput);
  };

  const onKeyDownInput = (e) => {
    if (e.key === "Enter") onClickLogin();
  };

  return (
    <>
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
        <button id="login" onClick={onClickLogin}>
          <LoginIcon />
          <span>Login</span>
        </button>
      </div>
    </>
  );
};

export default Home;
