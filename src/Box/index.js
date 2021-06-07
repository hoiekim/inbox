import React, { useState } from "react";
import Writer from "./components/Writer";
import Accounts from "./components/Accounts";
import Mails from "./components/Mails";
import "./index.scss";

const Box = () => {
  const [selectedAccount, setSelectedAccount] = useState("");

  return (
    <>
      <div className="pane side_pane">
        <Accounts setSelectedAccount={setSelectedAccount} />
      </div>
      <div className="pane main_pane">
        <Mails selectedAccount={selectedAccount} />
      </div>
      <Writer />
    </>
  );
};

export default Box;
