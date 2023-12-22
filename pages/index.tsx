import starStyles from "../styles/stars.module.scss";
import footerStyles from "../styles/footer.module.scss";
import indexStyles from "../styles/index.module.scss";

export default function Page() {

    return (
    <>
    <main>
        <div className={footerStyles.footer}>
            <object type="image/svg+xml" data="mountains_footer.svg" className={footerStyles.footerImage}/>
            <div className={footerStyles.iconContainer}>
                <a href="mailto:leonlenk@gmail.com" className="fa fa-google" id={footerStyles.socialIcon} />
                <a href="https://www.linkedin.com/in/leon-lenk/" className="fa fa-linkedin" id={footerStyles.socialIcon} />
                <a href="https://github.com/leonlenk" className="fa fa-github" id={footerStyles.socialIcon} />
            </div>
        </div>
        <div className={indexStyles.scrollableContainer}>
            <h1 className={indexStyles.title}>Welcome To My Website!</h1>
            <div className={indexStyles.constellationContainer}> 
                <div className={indexStyles.pawnContainer}>
                    {/* <object type="image/svg+xml" data="whitePawn.svg" className={indexStyles.whitePawn} />
                    <object type="image/svg+xml" data="star.svg" className={indexStyles.pawnStars} /> */}
                </div>
            </div>
        </div>
        <div className={starStyles.starContainer}>
            <object type="image/svg+xml" data="moon.svg" className={starStyles.moon}/>
            <p className={starStyles.background}>★</p>
            <p className={starStyles.midground}>★</p>
            <p className={starStyles.foreground}>★</p>
        </div>
    </main>
    </> 
    );
}