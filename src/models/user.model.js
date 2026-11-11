const prisma=require('../prisma');

async function findByEmail(email){
    return prisma.user.findUnique({
        where:{
            email:email
        }
    });

}

async function create(name,email,passwordHash){
    const user=await prisma.user.create({
        data:{
           name: name,email: email,passwordHash: passwordHash
        }
    });
    return user.id;
}

module.exports={
    findByEmail,
    create
}

