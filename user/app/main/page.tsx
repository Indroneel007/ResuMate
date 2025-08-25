import React from "react"
import { session } from "@descope/nextjs-sdk/server"

const MainPage = async () => {
  const s = await session();
  if(!s){
    return <div>Loading...</div>;
  }

  const {token, jwt} = s

  return (
    <div>
      Hello {String(token?.name || token?.sub)}
    </div>
  );
}

export default MainPage;