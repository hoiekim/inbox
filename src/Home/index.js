import React, { useState } from "react";
import { useHistory } from "react-router-dom";
import "./index.scss";

const domainName = process.env.REACT_APP_DOMAIN || "My Domain";

const Home = () => {
  const history = useHistory();
  const [pwInput, setPwInput] = useState("");

  const onChangePw = (e) => {
    setPwInput(e.target.value);
  };

  const login = () => {
    fetch("/admin", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        password: pwInput
      })
    }).then((r) => {
      history.push("/box");
    });
  };

  const onKeyDownInput = (e) => {
    if (e.key === "Enter") login();
  };

  return (
    <>
      <h1>{domainName} Inbox</h1>
      <h3 id="greeting">Please log in</h3>
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
          <i className="fas fa-sign-in-alt"></i>&nbsp;&nbsp;Login
        </button>
      </div>
    </>
  );
};

export default Home;
