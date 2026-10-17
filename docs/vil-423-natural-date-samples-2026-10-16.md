# VIL-423 — natural-date regeneration samples

## Additional wrong-weekday check

Injected text: `Les inscriptions ouvrent jeudi 12 août 2026 à 6 h 30, heure de Toronto.`
Actual independent parser returned Aug 12 / 06:30 / America/Toronto, **weekday 4**
with exact evidence **`jeudi`**. The source date is Wednesday (3); production
returned `accepted=false`. This is deliberately corrupted test text, not a generated
parent reply. Additional cost $0.00007388; final ledger **$10.584828315 / 456 calls**,
reserved $0. Source samples below retain their original checkpoint cost.

Approved regeneration — verbatim samples BEFORE recording commit.

Source prerequisites pushed: 9c9bf8a5e, 5e6258303, 80df58088. Same original $15 ledger: **$10.58475444 / 455 calls, reserved $0**. Regeneration/checks/judges added $0.22420318. One zero-spend local preflight failure remains audited (wrapper omitted countTokens, now forwarded). No ledger reset. Budget refusals still stop the round; the over-cap test asserts projected cost is logged and even a next smaller call throws.

**10/11 deliverable messages pass the >=4 judge floor. closing-soon-fr-CA remains HELD, not passed.** Raw French text contains mojibake; parser quoted corrected accents that are absent from the actual text, so exact-span verification correctly refuses it. No encoding repair or reroll. Whether corruption originated in generation or upstream transport is unconfirmed.

A prior safe false hold exposed parser-derived weekday numbers without weekday quotes. Code ignores that unstated optional metadata; a quoted wrong weekday still fails. SAME captured writer/parser answers replayed unchanged; no resampling, re-keying or prompt changes.

Saved official Markham HTML, historical Aug 12 clock, no carrier/real watches. Closing-soon is a parent-reported waitlist-offer deadline, NOT a website registration-closing date. Parsed values are normalization, not prescribed copy; unquoted inferred weekdays are not written claims.

### open-en — sent-shaped; judge 5/5

> Registration for LEGO: Preschool (Sundays at 10:15 AM, starting September 27, 2026) is listed as opening today, August 12, 2026, at 6:30 AM Toronto time. The course page currently shows the class as open, with 2 spots left, but that can change quickly. It's listed for ages 4 to 6, and I can't confirm from here whether your child fits that range. Prices shown: $121.16 for residents, $139.36 for non-residents. Here's the course page to register: https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=bfd08479-60d6-43d9-b586-5b4c8305a003&courseId=961140fe-0866-460f-9973-7c42cbe0a928 If you need to sign in first, use this link: https://cityofmarkham.perfectmind.com/Clients/MemberRegistration/MemberSignIn?returnUrl=https%3A%2F%2Fcityofmarkham.perfectmind.com%2FClients%2FBookMe4LandingPages%2FCoursesLandingPage%3FwidgetId%3Dbfd08479-60d6-43d9-b586-5b4c8305a003%26courseId%3D961140fe-0866-460f-9973-7c42cbe0a928 Good luck!

Parser openings: `[{"date":"2026-08-12","time":"06:30","timeZone":"America/Toronto","weekday":3,"confidence":"high","evidence":{"date":"today, August 12, 2026","time":"6:30 AM","timeZone":"Toronto time","weekday":null}}]`

### open-fr-CA — sent-shaped; judge 5/5

> Bonjour! C'est aujourd'hui, le 12 août 2026, que les inscriptions ouvrent pour « LEGO: Preschool » (cours pour les 4 à 6 ans, les dimanches à 10 h 15, à partir du 27 septembre 2026). Selon la page officielle, l'ouverture est à 6 h 30, heure de Toronto. D'après la page, il reste actuellement 2 places, mais cela peut changer vite. Les tarifs publiés sont de 121,16 $ pour les résidents et de 139,36 $ pour les non-résidents. Je n'ai pas pu confirmer si l'âge de votre enfant correspond à la tranche 4 à 6 ans; c'est à vous de le vérifier. Page du cours : https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=bfd08479-60d6-43d9-b586-5b4c8305a003&courseId=961140fe-0866-460f-9973-7c42cbe0a928 Pour vous connecter : https://cityofmarkham.perfectmind.com/Clients/MemberRegistration/MemberSignIn?returnUrl=https%3A%2F%2Fcityofmarkham.perfectmind.com%2FClients%2FBookMe4LandingPages%2FCoursesLandingPage%3FwidgetId%3Dbfd08479-60d6-43d9-b586-5b4c8305a003%26courseId%3D961140fe-0866-460f-9973-7c42cbe0a928 Bonne chance!

Parser openings: `[{"date":"2026-08-12","time":"06:30","timeZone":"America/Toronto","weekday":3,"confidence":"high","evidence":{"date":"aujourd'hui, le 12 août 2026","time":"6 h 30","timeZone":"heure de Toronto","weekday":null}}]`

### full-en — sent-shaped; judge 5/5

> Hi! Registration for Chess: Preschool (Mondays at 5:00 PM, starting September 21, 2026) opened today, August 12, 2026, at 6:30 AM Toronto time, per the official page. One important note: the page currently shows this course as full with 0 spots left, though a waitlist is listed as available (100 waitlist spots). Prices listed are $152.40 for residents and $175.32 for non-residents. The course is listed for ages 4 to 6, and I haven't confirmed whether your child fits that range, so please check that. Here is the course page: https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=bfd08479-60d6-43d9-b586-5b4c8305a003&courseId=85770d4d-bce9-4e53-b969-cf7e88775180 and here is the sign-in link: https://cityofmarkham.perfectmind.com/Clients/MemberRegistration/MemberSignIn?returnUrl=https%3A%2F%2Fcityofmarkham.perfectmind.com%2FClients%2FBookMe4LandingPages%2FCoursesLandingPage%3FwidgetId%3Dbfd08479-60d6-43d9-b586-5b4c8305a003%26courseId%3D85770d4d-bce9-4e53-b969-cf7e88775180

Parser openings: `[{"date":"2026-08-12","time":"06:30","timeZone":"America/Toronto","weekday":3,"confidence":"high","evidence":{"date":"August 12, 2026","time":"6:30 AM","timeZone":"Toronto time","weekday":null}}]`

### full-ar — sent-shaped; judge 4/5

> تذكير: يبدأ التسجيل في برنامج «Chess: Preschool» (الشطرنج لمرحلة ما قبل المدرسة) اليوم، الأربعاء 12 أغسطس 2026، الساعة 6:30 صباحًا بتوقيت تورنتو (وهو التوقيت المنشور في الصفحة الرسمية). رابط التسجيل: https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=bfd08479-60d6-43d9-b586-5b4c8305a003&courseId=85770d4d-bce9-4e53-b969-cf7e88775180 — ورابط تسجيل الدخول: https://cityofmarkham.perfectmind.com/Clients/MemberRegistration/MemberSignIn?returnUrl=https%3A%2F%2Fcityofmarkham.perfectmind.com%2FClients%2FBookMe4LandingPages%2FCoursesLandingPage%3FwidgetId%3Dbfd08479-60d6-43d9-b586-5b4c8305a003%26courseId%3D85770d4d-bce9-4e53-b969-cf7e88775180 . تنبيه مهم: تُظهر الصفحة حاليًا أن البرنامج ممتلئ (لا توجد أماكن متبقية)، لكن قائمة الانتظار متاحة وفيها 100 مكان شاغر بحسب قراءتنا للصفحة. معلومات البرنامج المنشورة: الفئة العمرية من 4 إلى 6 سنوات، ويبدأ يوم الاثنين 21 سبتمبر 2026 الساعة 5:00 مساءً، والسعر 152.40 دولارًا للمقيمين و175.32 دولارًا لغير المقيمين. هذه المعلومات منشورة في الصفحة ولا تؤكد أن طفلكم تنطبق عليه الشروط، فيُرجى التحقق من العمر قبل التسجيل.

Parser openings: `[{"date":"2026-08-12","time":"06:30","timeZone":"America/Toronto","weekday":3,"confidence":"high","evidence":{"date":"اليوم، الأربعاء 12 أغسطس 2026","time":"الساعة 6:30 صباحًا","timeZone":"بتوقيت تورنتو","weekday":"الأربعاء"}}]`

### closing-soon-en — sent-shaped; judge 4/5

> Hi! A quick check-in on the LEGO: Preschool course (Sundays at 10:15 AM, starting September 27, 2026). Registration opened on August 12, 2026 at 6:30 AM Toronto time. You mentioned you're number 2 on the waitlist, with a deadline around 7:00 AM Toronto time today (August 12, 2026). The page currently shows 2 spots left, but I can't confirm whether that applies to your waitlist spot, and Hale hasn't checked your account. Course page: https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=bfd08479-60d6-43d9-b586-5b4c8305a003&courseId=961140fe-0866-460f-9973-7c42cbe0a928 . Once you know how it turned out, just reply: got in, waitlisted (with your position, if you have one), or missed it.

Parser openings: `[{"date":"2026-08-12","time":"06:30","timeZone":"America/Toronto","weekday":3,"confidence":"high","evidence":{"date":"Registration opened on August 12, 2026","time":"6:30 AM","timeZone":"Toronto time","weekday":null}}]`

### closing-soon-fr-CA — HELD; no send

> Bonjour! Voici un petit suivi pour la liste d'attente du cours « LEGO: Preschool » (dimanche 27 septembre 2026, 10 h 15). D'aprĆØs ce que vous nous avez indiquĆ©, vous ĆÆtes en position 2 sur la liste d'attente, avec une date limite Ć  7 h aujourd'hui, le 12 aoĆ»t 2026 (heure de Toronto). Nous n'avons pas vĆ©rifiĆ© votre compte, donc ces renseignements viennent uniquement de vous. La page officielle du cours indique qu'il reste actuellement 2 places; pour la consulter : https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=bfd08479-60d6-43d9-b586-5b4c8305a003&courseId=961140fe-0866-460f-9973-7c42cbe0a928 . Les inscriptions ont ouvert aujourd'hui, le 12 aoĆ»t 2026, Ć  6 h 30 (heure de Toronto). Les tarifs publiĆ©s sont de 121,16 $ pour les rĆ©sidents et de 139,36 $ pour les non-rĆ©sidents. Le cours s'adresse aux enfants de 4 Ć  6 ans; nous n'avons pas pu confirmer si votre enfant correspond Ć  cette tranche d'Ć¢ge. Pour vous connecter : https://cityofmarkham.perfectmind.com/Clients/MemberRegistration/MemberSignIn?returnUrl=https%3A%2F%2Fcityofmarkham.perfectmind.com%2FClients%2FBookMe4LandingPages%2FCoursesLandingPage%3FwidgetId%3Dbfd08479-60d6-43d9-b586-5b4c8305a003%26courseId%3D961140fe-0866-460f-9973-7c42cbe0a928 . Dites-nous comment cela se passe : avez-vous obtenu une place, ĆŖtes-vous toujours sur la liste d'attente (et Ć  quelle position), ou avez-vous manquĆ© la date limite?

Parser openings: `[{"date":"2026-08-12","time":"06:30","timeZone":"America/Toronto","weekday":3,"confidence":"high","evidence":{"date":"aujourd'hui, le 12 août 2026","time":"6 h 30","timeZone":"heure de Toronto","weekday":null}}]`

### unconfirmed-en — sent-shaped; judge 5/5

> Hi, it's Hale with a heads-up on your course registration. I can't read the official course page right now, so I can't verify the registration opening date or confirm whether this course is open, closed, or still listed. Because of that, date reminders are paused while we recheck, and I won't send the evening-before plan until we have a verified date. Nothing here confirms that you qualify for the course or that a place is available. You can look at the official page yourself here: https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=bfd08479-60d6-43d9-b586-5b4c8305a003&courseId=961140fe-0866-460f-9973-7c42cbe0a928

Parser openings: `[]`

### unconfirmed-ar — sent-shaped; judge 4/5

> مرحبًا، هذا تذكير بخصوص التسجيل في الدورة. لم نتمكن حاليًا من قراءة الصفحة الرسمية للدورة، ولذلك لم نستطع التحقق من موعد فتح التسجيل أو من حالة الدورة. لهذا السبب أوقفنا مؤقتًا تذكيرات المواعيد، وسنعيد التحقق ونراسلك عندما يتوفر موعد مؤكد. لا نعرف إن كانت الدورة متاحة أو مغلقة أو تغيّرت. يمكنك الاطلاع على الصفحة الرسمية بنفسك هنا: https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=bfd08479-60d6-43d9-b586-5b4c8305a003&courseId=961140fe-0866-460f-9973-7c42cbe0a928

Parser openings: `[]`

### link-en — sent-shaped; judge 5/5

> Registration opens on Wednesday, August 12, 2026 at 6:30 AM Toronto time (Eastern). I verified this on the City of Markham registration page, which is here: https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=bfd08479-60d6-43d9-b586-5b4c8305a003&courseId=961140fe-0866-460f-9973-7c42cbe0a928
>
> That date is listed as open to the general public. I've put together a proposed reminder plan: a heads-up one week before, a note the evening before, and a reminder 15 minutes before opening. Nothing is scheduled yet. The plan needs your confirmation in approvals first, so please review it there. Keep in mind that I never sign up, pay, or hold a place for you. Registration itself is something you'd do on the website, and a published opening time doesn't guarantee spaces will be available.

Parser openings: `[{"date":"2026-08-12","time":"06:30","timeZone":"America/Toronto","weekday":3,"confidence":"high","evidence":{"date":"Wednesday, August 12, 2026","time":"6:30 AM","timeZone":"Toronto time (Eastern)","weekday":"Wednesday"}}]`

### link-fr-CA — sent-shaped; judge 5/5

> Bonjour! J'ai bien trouvé la page d'inscription et la date d'ouverture a été vérifiée : les inscriptions ouvrent le 12 août 2026 à 6 h 30, heure de Toronto (heure de l'Est). Selon les informations publiées, l'ouverture est générale. Voici la page : https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=bfd08479-60d6-43d9-b586-5b4c8305a003&courseId=961140fe-0866-460f-9973-7c42cbe0a928
>
> Je vous propose un plan de rappels, mais il n'est pas encore actif : il faut d'abord le confirmer dans la section des approbations. Une fois confirmé, il comprendrait un rappel une semaine avant l'ouverture, un rappel la veille au soir et un dernier rappel 15 minutes avant l'ouverture. Je ne vous inscris pas moi-même, je ne paie rien et je ne réserve aucune place : l'inscription et le paiement restent entièrement de votre côté, sur le site.

Parser openings: `[{"date":"2026-08-12","time":"06:30","timeZone":"America/Toronto","weekday":3,"confidence":"high","evidence":{"date":"12 août 2026","time":"6 h 30","timeZone":"heure de Toronto (heure de l'Est)","weekday":null}}]`

### link-ar — sent-shaped; judge 5/5

> تم تجهيز خطة تذكير مقترحة لموعد فتح التسجيل. بحسب الصفحة التي أرسلتها (وقد جرى التحقق منها)، يبدأ التسجيل يوم 12 أغسطس 2026 الساعة 6:30 صباحًا بتوقيت تورنتو (المنطقة الزمنية الشرقية لكندا). الصفحة تشير إلى أن التسجيل مفتوح للجميع. الرابط: https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=bfd08479-60d6-43d9-b586-5b4c8305a003&courseId=961140fe-0866-460f-9973-7c42cbe0a928
>
> الخطة المقترحة تتضمن ثلاث تذكيرات: تذكير قبل الموعد بأسبوع، وتذكير مساء اليوم السابق، وتذكير قبل فتح التسجيل بـ 15 دقيقة. هذه الخطة لم تُعتمد بعد، وتحتاج إلى تأكيدك من قسم الموافقات قبل أن تصبح فعّالة.
>
> وللتوضيح: هيل لا يسجّل ولا يدفع ولا يحجز مكانًا نيابةً عنك، فالتسجيل والدفع يبقيان بيدك أنت عند فتح التسجيل.

Parser openings: `[{"date":"2026-08-12","time":"06:30","timeZone":"America/Toronto","weekday":3,"confidence":"high","evidence":{"date":"12 أغسطس 2026","time":"6:30 صباحًا","timeZone":"تورنتو (المنطقة الزمنية الشرقية لكندا)","weekday":null}}]`

### Wrong-date negative control — HELD

Deliberately changed captured English Aug 12 to Aug 13, removing 'today' to avoid ambiguity. Injected corruption, NOT a claim the writer invented it. Actual independent parser: `[{"date":"2026-08-13","time":"06:30","timeZone":"America/Toronto","weekday":4,"confidence":"high","evidence":{"date":"August 13, 2026","time":"6:30 AM","timeZone":"Toronto time","weekday":null}}]`; source: `{"date":"2026-08-12","time":"06:30","timeZone":"America/Toronto","timePublished":true}`; accepted=false.

Legacy Finder re-record/Burlington still await explicit confirmation; neither ran. registrationWhen remains used by refresh, Coach/intake and fixtures, so retained.

Actions on 80df58088: [CI](https://github.com/villagehale/hale/actions/runs/38993407520), [Web E2E](https://github.com/villagehale/hale/actions/runs/38993407566), still running when checked; Vercel is not CI.

Please review the ten usable messages and held French failure. May I recover that single failed sample within the SAME remaining ledger? No paid calls running now. No merge/prod/remote migration/carrier send.
