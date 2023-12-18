import starStyles from "../styles/stars.module.scss";
import footerStyles from "../styles/footer.module.scss";
import Head from "next/head";

export default function Page() {
    return (
    <>
    <Head>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css"></link>
    </Head>
    <main>
        <div id={starStyles.background}/>
        <div id={starStyles.midground}/>
        <div id={starStyles.foreground}/>
        <div id={footerStyles.footer}>
            <div id={footerStyles.iconContainer}>
                <a href="mailto:leonlenk@gmail.com" className="fa fa-google" id={footerStyles.socialIcon} />
                <a href="https://github.com/leonlenk" className="fa fa-github" id={footerStyles.socialIcon} />
                <a href="https://www.linkedin.com/in/leon-lenk/" className="fa fa-linkedin" id={footerStyles.socialIcon} />
            </div>
        </div>
        <h1>Hello, Next.js!</h1>
    </main>
    </> 
    );
}