import starStyles from "../styles/stars.module.scss";
import footerStyles from "../styles/footer.module.scss";
import indexStyles from "../styles/index.module.scss";

export default function Page() {
    return (
    <>
    <main>
        <div id={starStyles.background}/>
        <div id={starStyles.midground}/>
        <div id={starStyles.foreground}/>
        <div id={footerStyles.footer}>
            <div id={footerStyles.iconContainer}>
                <a href="mailto:leonlenk@gmail.com" className="fa fa-google" id={footerStyles.socialIcon} />
                <a href="https://www.linkedin.com/in/leon-lenk/" className="fa fa-linkedin" id={footerStyles.socialIcon} />
                <a href="https://github.com/leonlenk" className="fa fa-github" id={footerStyles.socialIcon} />
            </div>
        </div>
        <h1 id={indexStyles.title}>Welcome To My Website!</h1>
    </main>
    </> 
    );
}