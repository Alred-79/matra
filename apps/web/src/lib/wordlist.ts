/**
 * The words generated passphrases are made of: 1,109 words of 3 to 5 lowercase letters, so each word adds
 * log2(1109) ≈ 10.1 bits; 6 words ≈ 60.7 bits, 7 words ≈ 70.8 bits (lib/passphrase.ts).
 *
 * Source: EFF's Short Wordlist #1 (1,296 words), https://www.eff.org/files/2016/09/08/eff_short_wordlist_1.txt
 * (SHA-256 of the file as downloaded on 2026-11-15: 8f5ca830b8bffb6fe39c9736c024a00a6a6411adb3f83a9be8bfeeb6e067ae69),
 * from "EFF's New Wordlists for Random Passphrases" by Joseph Bonneau, Electronic Frontier Foundation (2016).
 * Licence: Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/
 * (EFF's copyright page, https://www.eff.org/copyright). See NOTICE at the repository root.
 *
 * Changes: the dice numbers are dropped, and 187 words are removed in a first-pass screen (violence, weapons and crime;
 * court words; restraint, pursuit and surveillance; sexual words; body parts and bodily functions; illness, disability
 * and death; alcohol; drugs and how being drugged feels; medical and forensic exams; distressing feelings; insults;
 * religion and politics; marriage; and "yo-yo", whose hyphen is our separator). The pull request that brought this
 * list in names every removed word and why.
 *
 * NOT FINAL: an advocate who works with survivors must review this list before launch (plan §9.3 advocate gates).
 * The screen above was done by an engineer, not an advocate. Changing the list changes WORDLIST_SHA256 below, on
 * purpose: passphrase.test.ts pins it, so no edit lands without someone looking at it. Keep at least 1,024 words
 * (6 words must stay at or above 60 bits).
 */
export const WORDLIST: readonly string[] = `
acorn acre acts afar affix aged agent agile aging ahead aide aim ajar alarm alias alien alike alive aloe aloft aloha
amend amino ample amuse angel angle apple april apron aqua area arena argue arise armor aroma array art atlas atom
attic audio avert avoid awake award awoke axis bacon badge bagel baggy baked baker balmy banjo barge barn basil bask
batch baton bats blank blaze blend bless blimp blink bloat blob blog blot blurt blush boast boat boil bok bolt bonus
book booth boots boss botch both breed brick brim bring brink brisk broad broil broke brook broom brush buck bud
buggy bulge bulk bunch bunny bunt bush busy buzz cable cache cadet cake calm cameo canal candy cane canon cape card
cargo carol carry carve case cash cause cedar chair chant charm cheer chef chess chew chief chili chill chip chomp
chop chow chuck chunk churn chute cinch city civic civil clad claim clamp clap clash clasp class claw clay clean
clear cleat clerk click cling clink clip cloak clock clone cloth cloud clump coach coast coat cod coil cola cold
colt come comic comma cone cope copy coral cork cost cot couch cover cozy craft crane crank crate crave crawl creme
crepe crept crib crisp crop cross crowd crown crumb crush crust cub cupid cure curl curry curve cushy cycle dab dad
daily dairy daisy dance dandy darn dart dash data dawn deal dean debit debug decaf decal decay deck decor decoy deed
delay denim dense dent depth derby desk dial diary dice dig dill dime dimly diner dingy disco dish disk ditch dock
dodge doing doll dome donor donut dot dove down doze drab drama draw dress dried drift drill drive drone droop drove
drum dry duck duct dude dug duke duo dusk dust duty dwell eagle early earth easel east eaten eats ebay ebony ebook
echo edge eel eject elder elf elk elm elude elves email emit empty emu enter entry envoy equal erase error erupt
essay etch evade even evoke exact exit fable faced fact fade fall false fancy fang fax feast feed fence fend ferry
fetch fever fiber fifth fifty film final finch fit five flag flaky flame flap flask flick fling flint flip float
flock flop floss flyer foam fog foil folic folk food found fox foyer frame fray fresh fried frill from front frost
froth frown froze fruit gains gala game gap gas gave gear gecko geek gem genre gift gig gills given giver glad glass
glide gloss glove glow glue goal going golf gong good gooey goofy gown grain grant grape graph grasp grass gravy
gray green greet grew grid grill grip grit growl grub grunt guide gulf gulp gummy guru gush guy habit half halo halt
happy hasty hatch haven hazel hazy heap heat heave hedge hefty help herbs hers hub hula hull human humid hurry hut
ice icing icon icy igloo image ion iron issue item ivory ivy jam jazz jeep jelly jet jiffy job jog jolly jolt jot
joy juice juicy july jumbo jump junky keep kept kilt king kite kiwi koala kung ladle lady lair lake land lapel large
lasso last latch late lazy left legal lemon lend lens lent level lever lid life lift lilac lily limes line lint lion
list lived lunar lunch lurch lyric maker mama mango manor many map march mardi mash match mate math mocha mold mom
moody mop morse most motor motto mouse mousy move movie mower mud mug mulch mule mull mumbo mummy mural muse music
musky nacho nag nail name nanny nap navy near neat neon nerd nest net next niece ninth nutty oak oasis oat ocean oil
old olive omen onion only opal open opera opt otter ounce outer oval oven owl ozone pace pager palm panda pants
paper park party pasta patch path patio payer pecan penny pep perch perm pest petal petri petty photo plank plant
plaza plot plow pluck plug plus poach pod poem poet pogo point poise poker polar polka polo pond pony poppy pork
poser pouch pound pout power prank press print prior prism prize prong proof props prune pry pug pull pulp puma punk
pupil puppy purr purse push putt quack quake query quiet quill quilt quit quota quote race rack radar radio raft
rail rake rally ramp ranch range rank rant raven reach react ream rebel recap relax relay relic remix repay repel
reply rerun reset rhyme rice rich ride rigid rigor rinse ripen rise risk ritzy rival river roast robe robin rock
rogue roman romp rover royal ruby rug ruin rule runny rush rust rut sage said saint salad salon salsa salt same
sandy santa satin sauna saved savor sax say scale scan scarf scoff scoop scoot scope score scout scowl scrap scrub
scuba scuff sedan self send sepia serve set seven shack shade shady sham shape share sharp shed sheep sheet shelf
shell shine shiny ship shirt shop shore shout shown showy shred shrug shut shy sift silk silly silo sip siren sixth
size skate skew skid skier skies skip skirt skit sky slab slack slang slate slaw sled sleek sleep sleet slept slice
slick slimy sling slip slot slug slurp slush small smell smile smirk smog snack snap snarl sneak sniff snore snout
snowy snub snuff speak speed spend spent spill spiny spoil spoke spoof spool spoon sport spot spout spray spree spur
squad squat squid stack staff stage stall stamp stand stank stark start state stays steam steep stem step stew stick
sting stir stock stomp stony stood stool stoop stop storm stout stove straw stray strut stuck stuff stump stung
stunt suds sugar sulk surf sushi swan swarm sway swear sweep swell swept swim swing swipe swirl swoop swore syrup
tacky taco tag take tall talon tamer tank taper taps tarot tart task taste tasty thank thaw theme thing think thorn
those thud thump thus tiara tidal tidy tiger tile tilt tint tiny trace track trade train trait trash tray treat tree
trek trend tribe trick trio trout truce truck trunk try tug tulip turf tusk tutor tutu tux tweak tweet twice twine
twins twirl twist uncle uncut undo unify union unit untie upon upper urban used user usher utter value vapor vegan
venue verse vest veto vice video view viral virus visa visor vocal voice void volt voter vowel wad wafer wager wages
wagon wake walk wand wasp watch water wavy wheat whiff whole whoop wick widen width wifi wilt wind wing wink wipe
wired wiry wise wish wispy wok wolf wool word work woven xerox yahoo yam yard year yeast yelp yield yodel yoga yoyo
yummy zebra zero zesty zippy zone zoom
`
  .split(/\s+/)
  .filter(Boolean);

/** SHA-256 of the list joined with single spaces (see above: an edit must update this, and needs advocate review). */
export const WORDLIST_SHA256 = 'dcf4633c7fc60acdbbc7a214c21d17cc5bb8384018825990960b1c4a975318cc';
