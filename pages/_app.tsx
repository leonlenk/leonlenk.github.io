import type { AppProps } from 'next/app';
import Head from "next/head";
import "../styles/globals.scss";

export default function App({ Component, pageProps }: AppProps) {
  return (
  <>
  <Head>
    <meta charSet="utf-8" />
    <meta name="viewport" content="height=device-height, width=device-width, initial-scale=1, minimum-scale=1, target-densitydpi=device-dpi"/>
  </Head>
  <Component {...pageProps} />
  </> 
  );
}