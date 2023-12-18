import starStyles from "../styles/stars.module.scss";
import footerStyles from "../styles/footer.module.scss";

export default function Page() {
    return (
    <>    
    <main>
        <div id={starStyles.background}/>
        <div id={starStyles.midground}/>
        <div id={starStyles.foreground}/>
        <div id={footerStyles.footer}>
        </div>
        <h1>Hello, Next.js!</h1>
    </main>
    </>
    );
}