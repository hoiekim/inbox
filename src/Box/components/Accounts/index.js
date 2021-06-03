import React, { useState, useContext, useEffect } from "react";
import { useQuery } from "react-query";

import { Context } from "../../..";

const Accounts = () => {
  const [queryEnabled, setQueryEnabled] = useState(true);

  const getAccounts = () => fetch("/api/accounts").then((r) => r.json());
  const queryData = useQuery("getAccounts", getAccounts, {
    cacheTime: 0,
    enabled: queryEnabled
  });

  //   const { setRefetchAccounts } = useContext(Context);

  //   useEffect(() => {
  //     if (queryData.refetch && setRefetchAccounts) {
  //       setRefetchAccounts(queryData.refetch);
  //     }
  //   }, [queryData.refetch, setRefetchAccounts]);

  if (queryData.isLoading || queryData.error) return <></>;

  const accounts = Array.isArray(queryData.data) ? queryData.data : null;

  const Accounts = () => {
    const result = accounts?.map((data, i) => {
      const accountName = data.split("@")[0];
      return (
        <h3 key={i} className="tag cursor">
          <span>{accountName}</span>
          {/* <div className="numberBall">{unreadNo}</div> */}
        </h3>
      );
    });

    return result || <></>;
  };

  return (
    <div id="container-accounts" className="container">
      <Accounts />
    </div>
  );
};

export default Accounts;
