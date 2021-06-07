import React, { useContext } from "react";
import { useQuery } from "react-query";

import { Context } from "../../..";

import "./index.scss";

const Accounts = ({ selectedAccount, setSelectedAccount }) => {
  const { isWriterOpen, setIsWriterOpen } = useContext(Context);
  const getAccounts = () => fetch("/api/accounts").then((r) => r.json());
  const query = useQuery("getAccounts", getAccounts);

  if (query.isLoading) {
    return <div className="container">Loading Accounts List...</div>;
  }

  if (query.error) {
    return <div className="container">Accounts List Request Failed</div>;
  }

  if (query.isSuccess) {
    const accounts = Array.isArray(query.data) ? query.data : null;

    const Accounts = () => {
      const result = accounts?.map((data, i) => {
        const onClickAccount = () => {
          if (selectedAccount !== data) setSelectedAccount(data);
        };

        let className = "";
        if (selectedAccount === data) className = "tag clicked";
        else className = "tag cursor";

        return (
          <h3 key={i} className={className} onClick={onClickAccount}>
            <span>{data.split("@")[0]}</span>
            {/* TODO */}
            {/* <div className="numberBall">{unreadNo}</div> */}
          </h3>
        );
      });

      return result ? <div>{result}</div> : <></>;
    };

    const onClickCurtain = () => {
      setIsWriterOpen(false);
    };

    return (
      <>
        <div
          className={isWriterOpen ? "curtain on" : "curtain"}
          onClick={onClickCurtain}
        />
        <Accounts />
      </>
    );
  }
};

export default Accounts;
